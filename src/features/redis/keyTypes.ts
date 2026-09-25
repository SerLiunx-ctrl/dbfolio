export interface RedisKeyChange {
  deleted?: boolean;
  renamed?: string;
}

export type RedisKeyDialog = "rename" | "ttl" | "delete";
