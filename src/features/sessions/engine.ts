import type { Engine } from "../../ipc/types";
import { engineIconColor } from "./EngineIcon";

export const ENGINE_LABELS: Record<Engine, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
  redis: "Redis",
  mongodb: "MongoDB",
};

export const ENGINE_COLORS: Record<Engine, string> = {
  mysql: engineIconColor("mysql"),
  postgres: engineIconColor("postgres"),
  sqlite: engineIconColor("sqlite"),
  redis: engineIconColor("redis"),
  mongodb: "#479c50",
};

export const ENGINE_OPTIONS: Engine[] = ["mysql", "postgres", "sqlite", "redis", "mongodb"];

export const DEFAULT_PORTS: Partial<Record<Engine, number>> = {
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
  mongodb: 27017,
};

export const DEFAULT_USERNAMES: Partial<Record<Engine, string>> = {
  mysql: "root",
  postgres: "postgres",
};
