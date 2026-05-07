import process from "node:process";
import { executeSqlThroughFrostyWithWarehouse } from "./lib/frosty-client.mjs";

const [, , ...queryParts] = process.argv;
const query = queryParts.join(" ").trim();

if (!query) {
  console.error('Provide a SQL query. Example: npm run analytics:sql -- "select current_warehouse() as warehouse"');
  process.exit(1);
}

try {
  const result = await executeSqlThroughFrostyWithWarehouse(query);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
