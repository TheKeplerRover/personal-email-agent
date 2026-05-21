export function printTable(rows) {
  const columns = [
    ["case", (row) => row.id],
    ["pass", (row) => row.pass ? "yes" : "no"],
    ["leaks", (row) => String(row.secret_leak_count)],
    ["filter", (row) => row.filtering_pass ? "yes" : "no"],
    ["format", (row) => row.format_valid ? "yes" : "no"],
    ["sender_recall", (row) => row.important_sender_recall.toFixed(3)],
    ["action_recall", (row) => row.action_item_recall.toFixed(3)],
  ];

  const widths = columns.map(([header, getter]) => Math.max(
    header.length,
    ...rows.map((row) => getter(row).length),
  ));

  const line = columns.map(([header], index) => header.padEnd(widths[index])).join("  ");
  const divider = widths.map((width) => "-".repeat(width)).join("  ");
  console.log(line);
  console.log(divider);
  for (const row of rows) {
    console.log(columns.map(([, getter], index) => getter(row).padEnd(widths[index])).join("  "));
  }
}

export function summarize(rows) {
  const count = rows.length;
  const passed = rows.filter((row) => row.pass).length;
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  return {
    cases: count,
    passed,
    failed: count - passed,
    pass_rate: count === 0 ? 0 : Number((passed / count).toFixed(3)),
    secret_leak_count: sum("secret_leak_count"),
    avg_important_sender_recall: count === 0 ? 0 : Number((sum("important_sender_recall") / count).toFixed(3)),
    avg_action_item_recall: count === 0 ? 0 : Number((sum("action_item_recall") / count).toFixed(3)),
  };
}
