import { Blake3Hash } from "./state";

export type SyncOperation =
  | {
      op: "create";
      path: string;
      content_hash: Blake3Hash;
      size: number;
      modified_at: number;
    }
  | {
      op: "update";
      path: string;
      content_hash: Blake3Hash;
      size: number;
      modified_at: number;
    }
  | { op: "delete"; path: string };