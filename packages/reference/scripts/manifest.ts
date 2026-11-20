export interface SourceRecord {
  file: string;
  url: string;
  sha256: string;
  bytes: number;
  releaseDate: string;
  lastModified: string | null;
  fetchedAt: string;
  version?: string;
  archive?: { file: string; sha256: string; member: string };
}

export interface Manifest {
  jmdict: SourceRecord;
  kanjidic2: SourceRecord;
  wordfreq: SourceRecord;
}
