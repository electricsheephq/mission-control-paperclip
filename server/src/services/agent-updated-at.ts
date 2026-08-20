import { sql } from "drizzle-orm";
import { agents } from "@paperclipai/db";

export function nextAgentUpdatedAt() {
  return sql<Date>`GREATEST(CURRENT_TIMESTAMP, ${agents.updatedAt} + INTERVAL '1 millisecond')`;
}
