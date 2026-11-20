# @jle/grammar

Grammar points as data: one JSON file per point in `points/`, listed in `src/index.ts`. The engine's catalog keeps
only **approved** points, so a draft never reaches the learner (architecture §5.3).

## Reviewing and approving a point

Approval is a reviewed edit in this repo, made by someone who reads Japanese well. For each point:

1. Read `factSheet.body`: is the explanation correct and clear for a beginner?
2. Read every item in `contrasts`: is `answer` the only natural choice for the gap (＿), is `other` clearly wrong there,
   and does `translation` match?
3. Fix anything wrong, and if the point was approved before, raise `version` by one.
4. Mark it approved:

   ```json
   "factSheet": { "status": "approved", "approvedBy": "Your Name", "approvedAt": "2026-11-21", "body": "…" }
   ```

5. Commit it with the review. The tests fail if an approved point lacks `approvedBy` or `approvedAt`.

`pnpm --filter @jle/grammar status` lists every point and what is waiting for review.

## Fields

| Field | Meaning |
|---|---|
| `id`, `version` | Stable id; raise the version when the fact sheet or contrasts change after approval. |
| `label`, `tags` | Shown to the learner; Genki chapter and JLPT level order the points. |
| `prerequisites`, `confusables` | Ids of other points. A point is introduced only after its prerequisites have been met. |
| `matcher` | How to find the point in a passage: a list of alternatives, each a list of steps matched against consecutive tokens. A step may set `surface`, `lemma` (dictionary form), `pos` (first part-of-speech level, e.g. 助詞) and `form` (`te`: 連用形 followed by て/で). |
| `factSheet` | The explanation shown after a wrong contrast choice, and the approval gate. |
| `contrasts` | Sentences with one gap (＿), the right form and a confusable wrong one, and an English translation. |

The current points were drafted for this app and have not been reviewed.
