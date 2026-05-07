import process from "node:process";
import { executeSqlThroughFrostyWithWarehouse } from "./lib/frosty-client.mjs";
import { openDatabase, nowIso } from "./lib/db.mjs";

const ROSTER_QUERY = `
  select
    employee_id,
    full_name,
    first_name,
    last_name,
    work_email as employee_email,
    employee_status,
    worker_type,
    employee_type,
    employee_title,
    direct_manager_name,
    direct_manager_employee_id,
    default_cost_centers_full_path,
    split_part(default_cost_centers_full_path, '/', 1) as cost_center_level_1,
    split_part(default_cost_centers_full_path, '/', 2) as cost_center_level_2,
    split_part(default_cost_centers_full_path, '/', 3) as cost_center_level_3,
    split_part(default_cost_centers_full_path, '/', 4) as department_or_function,
    split_part(default_cost_centers_full_path, '/', 5) as sub_department_or_team,
    case
      when default_cost_centers_full_path ilike 'Corp/Corp/Corporate/%' then 1
      else 0
    end as is_corporate,
    location,
    market_id,
    ee_state as employee_state,
    tax_location,
    pay_group,
    pay_frequency,
    pay_calc,
    date_hired,
    date_rehired,
    date_terminated,
    position_effective_date,
    job_last_changed,
    datediff(day, coalesce(date_rehired, date_hired), coalesce(date_terminated, current_date)) as tenure_days,
    round(datediff(day, coalesce(date_rehired, date_hired), coalesce(date_terminated, current_date)) / 365.25, 2) as tenure_years
  from people_analytics.workday_raas.company_directory_sensitive
  where employee_status in (
    'Active',
    'On Leave',
    'Leave with Pay',
    'Leave without Pay',
    'Work Comp Leave'
  )
`;

const UPSERT_SQL = `
INSERT INTO employees (
  employee_id, full_name, first_name, last_name, employee_email,
  employee_status, worker_type, employee_type, employee_title,
  direct_manager_employee_id, direct_manager_name,
  cost_center_path, cost_center_level_1, cost_center_level_2, cost_center_level_3,
  department_or_function, sub_department_or_team, is_corporate,
  location, market_id, employee_state, tax_location,
  pay_group, pay_frequency, pay_calc,
  date_hired, date_rehired, date_terminated, position_effective_date, job_last_changed,
  tenure_days, tenure_years, synced_at
) VALUES (
  @employee_id, @full_name, @first_name, @last_name, @employee_email,
  @employee_status, @worker_type, @employee_type, @employee_title,
  @direct_manager_employee_id, @direct_manager_name,
  @cost_center_path, @cost_center_level_1, @cost_center_level_2, @cost_center_level_3,
  @department_or_function, @sub_department_or_team, @is_corporate,
  @location, @market_id, @employee_state, @tax_location,
  @pay_group, @pay_frequency, @pay_calc,
  @date_hired, @date_rehired, @date_terminated, @position_effective_date, @job_last_changed,
  @tenure_days, @tenure_years, @synced_at
)
ON CONFLICT(employee_id) DO UPDATE SET
  full_name = excluded.full_name,
  first_name = excluded.first_name,
  last_name = excluded.last_name,
  employee_email = excluded.employee_email,
  employee_status = excluded.employee_status,
  worker_type = excluded.worker_type,
  employee_type = excluded.employee_type,
  employee_title = excluded.employee_title,
  direct_manager_employee_id = excluded.direct_manager_employee_id,
  direct_manager_name = excluded.direct_manager_name,
  cost_center_path = excluded.cost_center_path,
  cost_center_level_1 = excluded.cost_center_level_1,
  cost_center_level_2 = excluded.cost_center_level_2,
  cost_center_level_3 = excluded.cost_center_level_3,
  department_or_function = excluded.department_or_function,
  sub_department_or_team = excluded.sub_department_or_team,
  is_corporate = excluded.is_corporate,
  location = excluded.location,
  market_id = excluded.market_id,
  employee_state = excluded.employee_state,
  tax_location = excluded.tax_location,
  pay_group = excluded.pay_group,
  pay_frequency = excluded.pay_frequency,
  pay_calc = excluded.pay_calc,
  date_hired = excluded.date_hired,
  date_rehired = excluded.date_rehired,
  date_terminated = excluded.date_terminated,
  position_effective_date = excluded.position_effective_date,
  job_last_changed = excluded.job_last_changed,
  tenure_days = excluded.tenure_days,
  tenure_years = excluded.tenure_years,
  synced_at = excluded.synced_at
`;

function rowToParams(row, syncedAt) {
  return {
    employee_id: String(row.EMPLOYEE_ID),
    full_name: row.FULL_NAME ?? null,
    first_name: row.FIRST_NAME ?? null,
    last_name: row.LAST_NAME ?? null,
    employee_email: row.EMPLOYEE_EMAIL ?? null,
    employee_status: row.EMPLOYEE_STATUS ?? null,
    worker_type: row.WORKER_TYPE ?? null,
    employee_type: row.EMPLOYEE_TYPE ?? null,
    employee_title: row.EMPLOYEE_TITLE ?? null,
    direct_manager_employee_id: row.DIRECT_MANAGER_EMPLOYEE_ID != null ? String(row.DIRECT_MANAGER_EMPLOYEE_ID) : null,
    direct_manager_name: row.DIRECT_MANAGER_NAME ?? null,
    cost_center_path: row.DEFAULT_COST_CENTERS_FULL_PATH ?? null,
    cost_center_level_1: row.COST_CENTER_LEVEL_1 ?? null,
    cost_center_level_2: row.COST_CENTER_LEVEL_2 ?? null,
    cost_center_level_3: row.COST_CENTER_LEVEL_3 ?? null,
    department_or_function: row.DEPARTMENT_OR_FUNCTION ?? null,
    sub_department_or_team: row.SUB_DEPARTMENT_OR_TEAM ?? null,
    is_corporate: row.IS_CORPORATE ?? 0,
    location: row.LOCATION ?? null,
    market_id: row.MARKET_ID != null ? String(row.MARKET_ID) : null,
    employee_state: row.EMPLOYEE_STATE ?? null,
    tax_location: row.TAX_LOCATION ?? null,
    pay_group: row.PAY_GROUP ?? null,
    pay_frequency: row.PAY_FREQUENCY ?? null,
    pay_calc: row.PAY_CALC ?? null,
    date_hired: row.DATE_HIRED ?? null,
    date_rehired: row.DATE_REHIRED ?? null,
    date_terminated: row.DATE_TERMINATED ?? null,
    position_effective_date: row.POSITION_EFFECTIVE_DATE ?? null,
    job_last_changed: row.JOB_LAST_CHANGED ?? null,
    tenure_days: row.TENURE_DAYS ?? null,
    tenure_years: row.TENURE_YEARS ?? null,
    synced_at: syncedAt,
  };
}

async function main() {
  console.log("Pulling employee roster from Snowflake...");
  const result = await executeSqlThroughFrostyWithWarehouse(ROSTER_QUERY);

  if (!result.success) {
    console.error("Frosty query failed:", result.error);
    process.exit(1);
  }

  const rows = result.data ?? [];
  console.log(`Fetched ${rows.length} active employees.`);

  const db = openDatabase();
  const syncedAt = nowIso();
  const upsert = db.prepare(UPSERT_SQL);

  const transaction = db.transaction((batch) => {
    let inserted = 0;
    let updated = 0;
    for (const row of batch) {
      const before = db.prepare("SELECT 1 FROM employees WHERE employee_id = ?").get(String(row.EMPLOYEE_ID));
      upsert.run(rowToParams(row, syncedAt));
      if (before) {
        updated += 1;
      } else {
        inserted += 1;
      }
    }
    return { inserted, updated };
  });

  const { inserted, updated } = transaction(rows);

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(is_corporate) AS corporate,
      SUM(CASE WHEN is_corporate = 0 THEN 1 ELSE 0 END) AS field,
      SUM(CASE WHEN employee_email IS NULL OR employee_email = '' THEN 1 ELSE 0 END) AS missing_email
    FROM employees
  `).get();

  console.log("\nSync complete.");
  console.log(`  inserted: ${inserted}`);
  console.log(`  updated:  ${updated}`);
  console.log(`\nDB totals:`);
  console.log(`  total employees:    ${totals.total}`);
  console.log(`  corporate:          ${totals.corporate}`);
  console.log(`  field:              ${totals.field}`);
  console.log(`  missing email:      ${totals.missing_email}`);
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exit(1);
}
