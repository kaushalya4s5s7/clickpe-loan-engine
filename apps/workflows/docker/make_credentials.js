// Builds n8n's credential import file from environment variables (secrets live only in .env).
const env = (k, d = "") => process.env[k] ?? d;
const url = new URL(env("APP_DATABASE_URL", "postgresql://postgres:postgres@postgres:5432/loan_engine"));
const sslmode = url.searchParams.get("sslmode") || "disable";

const credentials = [
  { id: "loanEngineDbCred", name: "Loan DB", type: "postgres", data: {
      host: url.hostname, port: Number(url.port || 5432), database: url.pathname.slice(1),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
      ssl: sslmode === "disable" ? "disable" : "require",
      allowUnauthorizedCerts: sslmode === "require" } },  // RDS: TLS on; CA pinning is the production step
  { id: "loanEngineSesCrd", name: "AWS SES", type: "aws", data: {
      region: env("SES_REGION", "ap-south-1"), accessKeyId: env("SES_ACCESS_KEY_ID"),
      secretAccessKey: env("SES_SECRET_ACCESS_KEY") } },
  { id: "loanEngineLlmCrd", name: "LLM API", type: "httpHeaderAuth", data: {
      name: "Authorization", value: `Bearer ${env("LLM_API_KEY")}` } },
];
process.stdout.write(JSON.stringify(credentials));
