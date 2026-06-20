import { Pool } from "pg";

// Postgres connection config
const pool = new Pool({
  connectionString: process.env.DATABASE_URL
});

export async function getUserData(userId: string) {
  // FAILURE 4: PostgreSQL connection leak
  // We check out a client from the pool but never call client.release()
  const client = await pool.connect();
  const res = await client.query("SELECT * FROM users WHERE id = $1", [userId]);
  
  // client.release(); // Leaking client connection!
  return res.rows[0];
}

// FAILURE 5: MongoDB missing index
// In the database query layer, we do queries on a field that lacks an index
export const MONGODB_SCHEMA_FINDINGS = {
  collection: "interviews",
  missingIndexOnField: "roomName",
  queryExample: "db.interviews.find({ roomName: 'room-123' })"
};
