import pg from "pg";
import { env } from "../config/env.js";

// DATE 列按原始 "YYYY-MM-DD" 文本返回：默认解析成 JS Date 后 JSON 序列化为 UTC ISO，
// 东八区前端按字符串截取日期会偏移一天（课表按天分组、日期列显示都受影响）
pg.types.setTypeParser(1082, (value) => value);

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 10
});

export async function withClient<T>(fn: (client: pg.PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
