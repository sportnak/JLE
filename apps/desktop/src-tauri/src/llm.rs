//! The one door to the model (architecture §7): raw HTTP to the Messages API, since Rust has no official SDK.
//! The engine sees only the `Llm` port; this module picks the model per route, sends structured-output requests,
//! checks `stop_reason` before reading content, and writes an `llm_call` row for every request it sends.

use crate::apikey;
use crate::events::EventStore;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::State;

const URL: &str = "https://api.anthropic.com/v1/messages";
const VERSION: &str = "2026-10-21";
const BETA: &str = "server-side-fallback-2026-07-01";
const OPUS: &str = "claude-opus-5-5";
const SONNET: &str = "claude-sonnet-5-5";
const TIMEOUT: Duration = Duration::from_secs(180);
const RETRIES: u32 = 2;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmRequest {
  pub route: String,
  pub prompt_version: String,
  pub system: String,
  pub user: String,
  pub schema: Value,
  pub max_tokens: u32,
  pub effort: String,
  pub session_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
  pub input_tokens: u64,
  pub output_tokens: u64,
  pub cache_read_tokens: u64,
  pub cache_write_tokens: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmResult {
  pub output: Value,
  pub stop_reason: String,
  /// The model that answered, which is the fallback model when the first one declined.
  pub model: String,
  pub call_id: String,
  pub latency_ms: u64,
  pub usage: Usage,
}

#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RouteUsage {
  pub route: String,
  pub calls: u64,
  pub input_tokens: u64,
  pub output_tokens: u64,
  pub cache_read_tokens: u64,
  pub cost_usd: f64,
}

/// §7.1: the five jobs and their models. Anything else is refused.
fn model_for(route: &str) -> Result<&'static str, String> {
  match route {
    "generate" | "tutor" | "explain" | "grade" => Ok(OPUS),
    "review" => Ok(SONNET),
    _ => Err(format!("unknown route `{route}`")),
  }
}

/// Per-million-token prices: input, output, cache read, cache write. Unknown models are priced as Opus.
fn prices(model: &str) -> [f64; 4] {
  match model {
    SONNET => [2.0, 10.0, 0.10, 2.50],
    _ => [4.0, 20.0, 0.20, 5.0],
  }
}

fn cost(model: &str, u: &Usage) -> f64 {
  let p = prices(model);
  (u.input_tokens as f64 * p[0]
    + u.output_tokens as f64 * p[1]
    + u.cache_read_tokens as f64 * p[2]
    + u.cache_write_tokens as f64 * p[3])
    / 1_000_000.0
}

/// The request body. No `thinking` (always on for these models), no sampling parameters, no prefill.
/// The system prompt is the stable part and is cached; the user message is the volatile part.
fn build_body(req: &LlmRequest) -> Result<Value, String> {
  let model = model_for(&req.route)?;
  if !matches!(req.effort.as_str(), "low" | "medium" | "high") {
    return Err(format!("unknown effort `{}`", req.effort));
  }
  if req.max_tokens == 0 {
    return Err("maxTokens must be positive".into());
  }
  if !req.schema.is_object() {
    return Err("schema must be a JSON schema object".into());
  }
  Ok(json!({
    "model": model,
    "max_tokens": req.max_tokens,
    "system": [{"type": "text", "text": req.system, "cache_control": {"type": "ephemeral"}}],
    "messages": [{"role": "user", "content": req.user}],
    "output_config": {
      "effort": req.effort,
      "format": {"type": "json_schema", "schema": req.schema},
    },
    "fallbacks": "default",
  }))
}

fn headers(key: &str) -> [(&'static str, String); 4] {
  [
    ("content-type", "application/json".into()),
    ("x-api-key", key.into()),
    ("anthropic-version", VERSION.into()),
    ("anthropic-beta", BETA.into()),
  ]
}

/// What a 200 response says, read in order: usage and model always, then the stop reason, then the content.
#[derive(Debug)]
struct Parsed {
  model: Option<String>,
  stop_reason: Option<String>,
  usage: Usage,
  output: Result<Value, String>,
}

fn parse_response(body: &Value) -> Parsed {
  let n = |k: &str| body.pointer(&format!("/usage/{k}")).and_then(Value::as_u64).unwrap_or(0);
  let usage = Usage {
    input_tokens: n("input_tokens"),
    output_tokens: n("output_tokens"),
    cache_read_tokens: n("cache_read_input_tokens"),
    cache_write_tokens: n("cache_creation_input_tokens"),
  };
  let model = body.get("model").and_then(Value::as_str).map(String::from);
  let stop_reason = body.get("stop_reason").and_then(Value::as_str).map(String::from);
  let output = match stop_reason.as_deref() {
    Some("refusal") => {
      let category = body.pointer("/stop_details/category").and_then(Value::as_str);
      Err(match category {
        Some(c) => format!("refused: {c}"),
        None => "refused".into(),
      })
    }
    Some("max_tokens") => Err("truncated".into()),
    _ => {
      let text: String = body
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
        .filter_map(|b| b.get("text").and_then(Value::as_str))
        .collect();
      if text.trim().is_empty() {
        Err("the response had no text".into())
      } else {
        serde_json::from_str(&text).map_err(|e| format!("the response was not valid JSON: {e}"))
      }
    }
  };
  Parsed { model, stop_reason, usage, output }
}

/// How long to wait before retry number `attempt + 1`, or `None` when the failure is not worth retrying.
fn retry_delay(status: u16, retry_after: Option<&str>, attempt: u32) -> Option<Duration> {
  let retryable = status == 429 || status == 529 || (500..600).contains(&status);
  if !retryable || attempt >= RETRIES {
    return None;
  }
  let hinted = retry_after.and_then(|s| s.trim().parse::<f64>().ok()).filter(|s| s.is_finite() && *s >= 0.0);
  Some(match hinted {
    Some(s) => Duration::from_secs_f64(s.min(60.0)),
    None => Duration::from_secs(1 << attempt),
  })
}

fn http_error(status: u16, body: &str) -> String {
  if status == 401 {
    return "The API key was rejected".into();
  }
  let message = serde_json::from_str::<Value>(body)
    .ok()
    .and_then(|v| v.pointer("/error/message").and_then(Value::as_str).map(String::from))
    .unwrap_or_else(|| body.chars().take(200).collect());
  format!("HTTP {status}: {message}")
}

/// Sends the request, retrying overloads and server errors. Blocking: call from `spawn_blocking`.
fn send(key: &str, body: &Value) -> Result<Value, String> {
  let agent: ureq::Agent = ureq::Agent::config_builder()
    .timeout_global(Some(TIMEOUT))
    .http_status_as_error(false)
    .build()
    .into();
  let payload = body.to_string();
  let mut attempt = 0;
  loop {
    let mut req = agent.post(URL);
    for (name, value) in headers(key) {
      req = req.header(name, value);
    }
    let mut resp = req.send(&payload).map_err(|e| format!("Could not reach the API: {e}"))?;
    let status = resp.status().as_u16();
    let retry_after = resp.headers().get("retry-after").and_then(|v| v.to_str().ok()).map(String::from);
    let text = resp.body_mut().read_to_string().map_err(|e| format!("Could not read the response: {e}"))?;
    if status == 200 {
      return serde_json::from_str(&text).map_err(|e| format!("the API returned invalid JSON: {e}"));
    }
    match retry_delay(status, retry_after.as_deref(), attempt) {
      Some(wait) => {
        log::warn!("API returned {status}; retrying in {wait:?}");
        std::thread::sleep(wait);
        attempt += 1;
      }
      None => return Err(http_error(status, &text)),
    }
  }
}

/// One `llm_call` row.
#[derive(Debug, Default)]
struct CallRow {
  id: String,
  at: String,
  route: String,
  prompt_version: String,
  model: String,
  session_id: Option<String>,
  usage: Usage,
  latency_ms: u64,
  stop_reason: Option<String>,
  error: Option<String>,
}

fn record(conn: &Connection, row: &CallRow) -> rusqlite::Result<()> {
  conn
    .execute(
      "INSERT INTO llm_call (id, at, route, prompt_version, model, session_id, input_tokens, output_tokens,
         cache_read_tokens, cache_write_tokens, latency_ms, stop_reason, error)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
      params![
        row.id,
        row.at,
        row.route,
        row.prompt_version,
        row.model,
        row.session_id,
        row.usage.input_tokens as i64,
        row.usage.output_tokens as i64,
        row.usage.cache_read_tokens as i64,
        row.usage.cache_write_tokens as i64,
        row.latency_ms as i64,
        row.stop_reason,
        row.error
      ],
    )
    .map(|_| ())
}

/// Turns a finished request into the row to write and the command's answer.
fn finish(
  req: &LlmRequest,
  requested_model: &str,
  response: Result<Value, String>,
  latency_ms: u64,
) -> (CallRow, Result<LlmResult, String>) {
  let mut row = CallRow {
    id: uuid::Uuid::new_v4().to_string(),
    at: now_iso(),
    route: req.route.clone(),
    prompt_version: req.prompt_version.clone(),
    model: requested_model.to_string(),
    session_id: req.session_id.clone(),
    latency_ms,
    ..Default::default()
  };
  let parsed = match response {
    Ok(body) => parse_response(&body),
    Err(e) => {
      row.error = Some(e.clone());
      return (row, Err(e));
    }
  };
  if let Some(m) = parsed.model {
    row.model = m;
  }
  row.usage = parsed.usage;
  row.stop_reason = parsed.stop_reason;
  let result = match parsed.output {
    Ok(output) => Ok(LlmResult {
      output,
      stop_reason: row.stop_reason.clone().unwrap_or_default(),
      model: row.model.clone(),
      call_id: row.id.clone(),
      latency_ms,
      usage: row.usage.clone(),
    }),
    Err(e) => {
      row.error = Some(e.clone());
      Err(e)
    }
  };
  (row, result)
}

type Store<'a> = State<'a, Mutex<EventStore>>;

#[tauri::command]
pub async fn llm_call(store: Store<'_>, request: LlmRequest) -> Result<LlmResult, String> {
  let body = build_body(&request)?;
  let key = apikey::load()?.ok_or("No API key is set. Add one in Settings.")?;
  let model = model_for(&request.route)?;
  let started = Instant::now();
  let response = tauri::async_runtime::spawn_blocking(move || send(&key, &body))
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r);
  let latency_ms = started.elapsed().as_millis() as u64;
  let (row, result) = finish(&request, model, response, latency_ms);
  if let Err(e) = record(store.lock().unwrap().conn(), &row) {
    log::error!("could not write llm_call row: {e}");
  }
  result
}

fn usage_by_route(conn: &Connection) -> rusqlite::Result<Vec<RouteUsage>> {
  let mut stmt = conn.prepare(
    "SELECT route, model, count(*), sum(input_tokens), sum(output_tokens), sum(cache_read_tokens),
       sum(cache_write_tokens)
     FROM llm_call GROUP BY route, model",
  )?;
  let mut routes: BTreeMap<String, RouteUsage> = BTreeMap::new();
  let rows = stmt.query_map([], |r| {
    let n = |i| r.get::<_, i64>(i).map(|v| v as u64);
    Ok((
      r.get::<_, String>(0)?,
      r.get::<_, String>(1)?,
      n(2)?,
      Usage { input_tokens: n(3)?, output_tokens: n(4)?, cache_read_tokens: n(5)?, cache_write_tokens: n(6)? },
    ))
  })?;
  for row in rows {
    let (route, model, calls, u) = row?;
    let e = routes.entry(route.clone()).or_insert(RouteUsage {
      route,
      calls: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cost_usd: 0.0,
    });
    e.calls += calls;
    e.input_tokens += u.input_tokens;
    e.output_tokens += u.output_tokens;
    e.cache_read_tokens += u.cache_read_tokens;
    e.cost_usd += cost(&model, &u);
  }
  Ok(routes.into_values().collect())
}

#[tauri::command]
pub fn llm_usage(store: Store) -> Result<Vec<RouteUsage>, String> {
  usage_by_route(store.lock().unwrap().conn()).map_err(|e| e.to_string())
}

/// Now as `YYYY-MM-DDTHH:MM:SS.mmmZ`.
fn now_iso() -> String {
  let ms = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
  iso_from_millis(ms)
}

fn iso_from_millis(ms: i64) -> String {
  let (days, rem) = (ms.div_euclid(86_400_000), ms.rem_euclid(86_400_000));
  // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
  let z = days + 719_468;
  let era = z.div_euclid(146_097);
  let doe = z - era * 146_097;
  let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
  let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
  let mp = (5 * doy + 2) / 153;
  let day = doy - (153 * mp + 2) / 5 + 1;
  let month = if mp < 10 { mp + 3 } else { mp - 9 };
  let year = yoe + era * 400 + i64::from(month <= 2);
  let (h, m, s, milli) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
  format!("{year:04}-{month:02}-{day:02}T{h:02}:{m:02}:{s:02}.{milli:03}Z")
}

#[cfg(test)]
mod tests {
  use super::*;

  fn request(route: &str) -> LlmRequest {
    LlmRequest {
      route: route.into(),
      prompt_version: "generate-v1".into(),
      system: "You write graded readers.".into(),
      user: "Write about cats.".into(),
      schema: json!({"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]}),
      max_tokens: 4000,
      effort: "medium".into(),
      session_id: Some("s1".into()),
    }
  }

  fn temp_store(name: &str) -> EventStore {
    let path = std::env::temp_dir().join(format!("jle-test-{}-llm-{name}.sqlite", std::process::id()));
    let _ = std::fs::remove_file(&path);
    EventStore::open(path).unwrap()
  }

  fn response(stop: &str, content: Value) -> Value {
    json!({
      "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-opus-5-5",
      "stop_reason": stop, "stop_details": null, "content": content,
      "usage": {"input_tokens": 100, "output_tokens": 50, "cache_read_input_tokens": 1000,
                "cache_creation_input_tokens": 10}
    })
  }

  #[test]
  fn routes_pick_their_models() {
    for (route, model) in [
      ("generate", OPUS),
      ("tutor", OPUS),
      ("explain", OPUS),
      ("grade", OPUS),
      ("review", SONNET),
    ] {
      assert_eq!(model_for(route), Ok(model));
      assert_eq!(build_body(&request(route)).unwrap()["model"], model);
    }
    assert!(model_for("chat").is_err());
  }

  #[test]
  fn body_has_structured_output_caching_and_fallbacks_and_nothing_else() {
    let body = build_body(&request("generate")).unwrap();
    assert_eq!(body["max_tokens"], 4000);
    assert_eq!(body["fallbacks"], "default");
    assert_eq!(body["system"][0]["text"], "You write graded readers.");
    assert_eq!(body["system"][0]["cache_control"], json!({"type": "ephemeral"}));
    assert_eq!(body["messages"], json!([{"role": "user", "content": "Write about cats."}]));
    assert_eq!(body["output_config"]["effort"], "medium");
    assert_eq!(body["output_config"]["format"]["type"], "json_schema");
    assert_eq!(body["output_config"]["format"]["schema"], request("generate").schema);
    let keys: Vec<&String> = body.as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 6, "{keys:?}");
    for absent in ["thinking", "temperature", "top_p", "top_k"] {
      assert!(body.get(absent).is_none(), "{absent}");
    }
  }

  #[test]
  fn body_rejects_bad_requests() {
    let mut r = request("generate");
    r.effort = "max".into();
    assert!(build_body(&r).is_err());
    let mut r = request("generate");
    r.max_tokens = 0;
    assert!(build_body(&r).is_err());
    let mut r = request("generate");
    r.schema = json!("text");
    assert!(build_body(&r).is_err());
  }

  #[test]
  fn headers_carry_version_beta_and_key() {
    let h: BTreeMap<_, _> = headers("sk-ant-x").into_iter().collect();
    assert_eq!(h["x-api-key"], "sk-ant-x");
    assert_eq!(h["anthropic-version"], "2026-10-21");
    assert_eq!(h["anthropic-beta"], "server-side-fallback-2026-07-01");
    assert_eq!(h["content-type"], "application/json");
  }

  #[test]
  fn reads_json_from_text_blocks_and_skips_the_rest() {
    let body = response(
      "end_turn",
      json!([
        {"type": "thinking", "thinking": "", "signature": "abc"},
        {"type": "fallback", "from": {"model": "claude-opus-5-5"}, "to": {"model": "claude-opus-4-8"}},
        {"type": "text", "text": "{\"text\": "},
        {"type": "text", "text": "\"猫\"}"}
      ]),
    );
    let p = parse_response(&body);
    assert_eq!(p.output, Ok(json!({"text": "猫"})));
    assert_eq!(p.stop_reason.as_deref(), Some("end_turn"));
    assert_eq!(p.usage, Usage { input_tokens: 100, output_tokens: 50, cache_read_tokens: 1000, cache_write_tokens: 10 });
  }

  #[test]
  fn refusal_and_truncation_are_errors_even_with_text() {
    let mut refused = response("refusal", json!([{"type": "text", "text": "{}"}]));
    refused["stop_details"] = json!({"type": "refusal", "category": "cyber", "explanation": null});
    assert_eq!(parse_response(&refused).output, Err("refused: cyber".into()));
    let bare = response("refusal", json!([]));
    assert_eq!(parse_response(&bare).output, Err("refused".into()));
    let cut = response("max_tokens", json!([{"type": "text", "text": "{\"text\": \"猫"}]));
    assert_eq!(parse_response(&cut).output, Err("truncated".into()));
    let prose = response("end_turn", json!([{"type": "text", "text": "Sure!"}]));
    assert!(parse_response(&prose).output.is_err());
  }

  #[test]
  fn retries_overloads_and_server_errors_only() {
    assert_eq!(retry_delay(429, Some("3"), 0), Some(Duration::from_secs(3)));
    assert_eq!(retry_delay(529, None, 0), Some(Duration::from_secs(1)));
    assert_eq!(retry_delay(500, None, 1), Some(Duration::from_secs(2)));
    assert_eq!(retry_delay(503, Some("600"), 0), Some(Duration::from_secs(60)));
    assert_eq!(retry_delay(529, None, 2), None);
    assert_eq!(retry_delay(400, None, 0), None);
    assert_eq!(retry_delay(401, None, 0), None);
    assert_eq!(http_error(401, ""), "The API key was rejected");
    let body = r#"{"type":"error","error":{"type":"invalid_request_error","message":"bad schema"}}"#;
    assert_eq!(http_error(400, body), "HTTP 400: bad schema");
  }

  #[test]
  fn every_call_writes_a_row() {
    let store = temp_store("rows");
    let req = request("generate");
    let ok = response("end_turn", json!([{"type": "text", "text": "{\"text\": \"猫\"}"}]));
    let (row, result) = finish(&req, OPUS, Ok(ok), 1200);
    record(store.conn(), &row).unwrap();
    let result = result.unwrap();
    assert_eq!(result.call_id, row.id);
    assert_eq!(result.model, "claude-opus-5-5");
    let (row, result) = finish(&req, OPUS, Err("The API key was rejected".into()), 300);
    record(store.conn(), &row).unwrap();
    assert!(result.is_err());
    let mut refused = response("refusal", json!([]));
    refused["model"] = json!("claude-opus-4-8");
    let (row, result) = finish(&request("grade"), OPUS, Ok(refused), 900);
    record(store.conn(), &row).unwrap();
    assert!(result.is_err());

    let rows: Vec<(String, String, Option<String>, Option<String>, i64)> = store
      .conn()
      .prepare("SELECT route, model, stop_reason, error, input_tokens FROM llm_call ORDER BY latency_ms")
      .unwrap()
      .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?)))
      .unwrap()
      .collect::<Result<_, _>>()
      .unwrap();
    assert_eq!(
      rows,
      vec![
        ("generate".into(), OPUS.into(), None, Some("The API key was rejected".into()), 0),
        ("grade".into(), "claude-opus-4-8".into(), Some("refusal".into()), Some("refused".into()), 100),
        ("generate".into(), OPUS.into(), Some("end_turn".into()), None, 100),
      ]
    );
    let at: String = store.conn().query_row("SELECT at FROM llm_call LIMIT 1", [], |r| r.get(0)).unwrap();
    assert!(at.ends_with('Z') && at.len() == 24, "{at}");
  }

  #[test]
  fn usage_is_summed_and_priced_per_route() {
    let store = temp_store("usage");
    let row = |id: &str, route: &str, model: &str, u: Usage| CallRow {
      id: id.into(),
      route: route.into(),
      model: model.into(),
      usage: u,
      ..Default::default()
    };
    let million = Usage { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_tokens: 1_000_000, cache_write_tokens: 1_000_000 };
    record(store.conn(), &row("a", "generate", OPUS, million.clone())).unwrap();
    record(store.conn(), &row("b", "grade", SONNET, million.clone())).unwrap();
    record(store.conn(), &row("c", "grade", "claude-opus-4-8", million.clone())).unwrap();
    let usage = usage_by_route(store.conn()).unwrap();
    assert_eq!(usage.len(), 2);
    assert_eq!(usage[0].route, "generate");
    assert!((usage[0].cost_usd - 29.2).abs() < 1e-9);
    assert_eq!(usage[1].calls, 2);
    assert_eq!(usage[1].input_tokens, 2_000_000);
    assert!((usage[1].cost_usd - (14.6 + 29.2)).abs() < 1e-9);
  }

  #[test]
  fn formats_utc_timestamps() {
    assert_eq!(iso_from_millis(0), "1970-01-01T00:00:00.000Z");
    assert_eq!(iso_from_millis(1_795_176_000_123), "2026-11-20T12:00:00.123Z");
    assert_eq!(iso_from_millis(951_782_400_000), "2000-02-29T00:00:00.000Z");
  }
}
