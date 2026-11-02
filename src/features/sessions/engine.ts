import type { Engine } from "../../ipc/types";
import { engineIconColor } from "./EngineIcon";

export const ENGINE_LABELS: Record<Engine, string> = {
  mysql: "MySQL",
  postgres: "PostgreSQL",
  sqlite: "SQLite",
  redis: "Redis",
  mongodb: "MongoDB",
  kafka: "Kafka",
  rabbitmq: "RabbitMQ",
  rocketmq: "RocketMQ",
};

export const ENGINE_COLORS: Record<Engine, string> = {
  mysql: engineIconColor("mysql"),
  postgres: engineIconColor("postgres"),
  sqlite: engineIconColor("sqlite"),
  redis: engineIconColor("redis"),
  mongodb: "#479c50",
  kafka: "#687888",
  rabbitmq: "#e87924",
  rocketmq: "#cb3f66",
};

export const ENGINE_OPTIONS: Engine[] = ["mysql", "postgres", "sqlite", "redis", "mongodb", "kafka", "rabbitmq", "rocketmq"];

export const DEFAULT_PORTS: Partial<Record<Engine, number>> = {
  mysql: 3306,
  postgres: 5432,
  redis: 6379,
  mongodb: 27017,
  kafka: 9092,
  rabbitmq: 15672,
  rocketmq: 8082,
};

export const DEFAULT_USERNAMES: Partial<Record<Engine, string>> = {
  mysql: "root",
  postgres: "postgres",
};

/** 连接协议保持 mysql，服务器名称在连接后按真实版本识别。 */
export const CONNECTION_ENGINE_LABELS = { ...ENGINE_LABELS, mysql: "MySQL / MariaDB" };
export function serverEngineLabel(engine: Engine, serverVersion?: string | null): string {
  return engine === "mysql" && /mariadb/i.test(serverVersion ?? "") ? "MariaDB" : ENGINE_LABELS[engine];
}

export const isMessageQueue=(engine:Engine)=>["kafka","rabbitmq","rocketmq"].includes(engine);
