// Bridge for Python tests: node run_module.js <module> <function>  (JSON args array on stdin → JSON on stdout)
const [mod, fn] = process.argv.slice(2);
const m = require(`../src/code/${mod}.js`);
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const out = m[fn](...JSON.parse(input));
  process.stdout.write(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
});
