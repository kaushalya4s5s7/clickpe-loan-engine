# System flow: one picture

From "I open the website" to "the user gets an email". Follow the numbers.
Colours show **who does the work**: blue = browser, orange = Go on AWS, green = database, purple = n8n in Docker.

```mermaid
flowchart TB
  %% ================= BROWSER =================
  subgraph BROWSER["🖥️ BROWSER — Next.js page, served from S3 + CloudFront"]
    U1["1 · User picks users.csv<br/>browser checks the columns"]
    U5["5 · Browser cuts the file into 8 MB pieces<br/>and uploads them STRAIGHT to S3, 4 at a time"]
    U7["7 · Browser says 'all pieces sent'"]
    U99["🔁 Every few seconds the page asks<br/>'what's the status of my batch?'<br/>and shows the progress tracker"]
  end

  %% ================= GO ON AWS =================
  subgraph GO["⚙️ GO CODE ON AWS LAMBDA"]
    API2["2 · API Lambda: POST /v1/uploads<br/>creates a batch row, status = CREATED"]
    API4["4 · API Lambda hands back<br/>signed upload links, one per piece"]
    API8["8 · API Lambda: POST /complete<br/>tells S3 to glue the pieces together<br/>status = UPLOADED"]
    ING10["10 · INGEST Lambda wakes up<br/>reads the file as a stream, row by row<br/>cleans: ₹1,20,000 → 120000, '1.2L', 'NA'<br/>rejects bad rows into an error report"]
    ING11["11 · Bulk-copies good rows into Postgres<br/>in ONE transaction<br/>status = LOADED"]
    ING12["12 · Rings the n8n DOORBELL<br/>HTTP POST signed with a secret<br/>'batch X is ready'"]
    STATUS["GET /v1/batches/:id<br/>reads the status for the page"]
  end

  S3[("📦 S3 bucket<br/>stores the raw CSV for 7 days")]
  SQS[["📬 SQS queue<br/>'a new file arrived' message<br/>3 failed tries → dead-letter queue + alarm"]]

  %% ================= DATABASE =================
  subgraph DB["🗄️ POSTGRES on AWS RDS — the shared notebook everyone reads and writes"]
    T_BATCH[("ingest_batches<br/>one row per upload + its STATUS")]
    T_USERS[("users")]
    T_PROD[("loan_products<br/>written by the crawler")]
    T_MATCH[("matches<br/>user ↔ loan")]
    T_NOTIF[("notifications<br/>who was emailed")]
    T_EVENTS[("pipeline_events<br/>timeline + errors")]
  end

  %% ================= N8N =================
  subgraph N8N["🤖 n8n IN DOCKER — the automation workflows"]
    subgraph WFA["Workflow A · CRAWL — runs alone, every night"]
      A1["⏰ Trigger: every day 02:00 IST"]
      A2["Download HDFC / ICICI / Kotak pages<br/>page changed? → ask the LLM to read the rules<br/>unchanged? → skip, no LLM cost"]
    end
    subgraph WFB["Workflow B · MATCH"]
      B0a["🔔 Trigger 1: Doorbell webhook<br/>check the signature first"]
      B0b["⏰ Trigger 2: Sweeper every 2 min<br/>'any LOADED batch someone forgot?'"]
      B1["13 · Claim the batch<br/>LOADED → MATCHING<br/>only ONE runner can win"]
      B2["14 · Group similar users<br/>10,000 users → ~229 groups<br/>fast yes/no check per group"]
      B3["15 · Fuzzy rule? Ask the LLM<br/>only if never asked before (cached)"]
      B4["16 · Save matches<br/>MATCHING → MATCHED"]
    end
    subgraph WFC["Workflow C · NOTIFY"]
      C0["▶️ Trigger: started by B"]
      C1["17 · Claim: MATCHED → NOTIFYING<br/>pick users: consented, not emailed in 7 days<br/>TEST MODE → send to our own Gmail only"]
      C2["18 · Loop: one email at a time<br/>send via AWS SES → mark SENT or FAILED<br/>wait 1 second, next"]
      C3["19 · Finish: NOTIFYING → DONE ✅"]
    end
    subgraph WFE["Workflow E · ERRORS"]
      E1["💥 Trigger: A, B or C crashed<br/>write the crash into pipeline_events"]
    end
  end

  LLM(["🧠 LLM API"])
  SES(["✉️ AWS SES"])
  INBOX(["📥 User's inbox"])
  BANKS(["🏦 Bank websites"])

  %% ---------- the upload ----------
  U1 -->|"POST /v1/uploads<br/>name + size only, no file"| API2
  API2 --> T_BATCH
  API2 --> API4
  API4 -->|"links"| U5
  U5 ==>|"6 · the actual file bytes<br/>never pass through Go"| S3
  U5 --> U7
  U7 -->|"POST /complete"| API8
  API8 --> T_BATCH
  S3 -->|"9 · 'file created' event"| SQS
  SQS --> ING10
  ING10 --> ING11
  ING11 --> T_USERS
  ING11 --> T_BATCH
  ING11 --> ING12

  %% ---------- Go → n8n ----------
  ING12 ==>|"signed HTTP POST<br/>through a tunnel"| B0a
  B0b -.->|"backup if the doorbell got lost"| T_BATCH
  B0a --> B1
  B0b --> B1
  B1 --> B2 --> B3 --> B4
  T_PROD -.->|"B reads the loan rules"| B2
  B3 <--> LLM
  B4 --> T_MATCH
  B4 ==>|"B presses C's start button"| C0

  %% ---------- notify ----------
  C0 --> C1 --> C2 --> C3
  T_MATCH -.-> C1
  C1 --> T_NOTIF
  C2 --> SES --> INBOX
  C3 --> T_BATCH

  %% ---------- crawler (independent) ----------
  A1 --> A2
  A2 <--> BANKS
  A2 <--> LLM
  A2 --> T_PROD

  %% ---------- errors + status polling ----------
  WFA & WFB & WFC -.->|"on crash"| E1
  E1 --> T_EVENTS
  U99 -->|"GET status"| STATUS
  STATUS -.-> T_BATCH

  classDef browser fill:#dbeafe,stroke:#2563eb,color:#111
  classDef go fill:#ffedd5,stroke:#ea580c,color:#111
  classDef db fill:#dcfce7,stroke:#16a34a,color:#111
  classDef n8n fill:#ede9fe,stroke:#7c3aed,color:#111
  classDef ext fill:#f3f4f6,stroke:#6b7280,color:#111
  class U1,U5,U7,U99 browser
  class API2,API4,API8,ING10,ING11,ING12,STATUS go
  class T_BATCH,T_USERS,T_PROD,T_MATCH,T_NOTIF,T_EVENTS db
  class A1,A2,B0a,B0b,B1,B2,B3,B4,C0,C1,C2,C3,E1 n8n
  class S3,SQS,LLM,SES,INBOX,BANKS ext
```

## The batch's life, as one line

The `status` column in `ingest_batches` is the baton passed between Go and n8n:

```
CREATED ─► UPLOADED ─► PARSING ─► LOADED ─► MATCHING ─► MATCHED ─► NOTIFYING ─► DONE
└──────── Go (API + ingest Lambda) ──────┘ └─ n8n workflow B ─┘ └─ n8n workflow C ─┘
                                (anything can end in FAILED; the user can cancel → ABORTED)
```

## Who owns what

| Part | Owner | Why it lives there |
|---|---|---|
| Upload session, signed links, status API | Go (API Lambda) | Fast, cheap, needs AWS permissions |
| Moving the file bytes | Browser → S3 directly | API Gateway can't take files over 10 MB; S3 can |
| Parsing + cleaning + saving 1M rows | Go (ingest Lambda) | CPU-heavy; Go does 1M rows in ~6 s |
| Reading bank websites | n8n workflow A | The brief asks for n8n; it runs on a schedule |
| Matching users to loans | n8n workflow B | The brief asks for n8n; SQL + JS + LLM steps |
| Emails | n8n workflow C → AWS SES | The brief asks for n8n's SES node |
| Recording crashes | n8n workflow E | Built-in n8n "error workflow" feature |
| The handover between all of them | Postgres (`status` column) + the doorbell | Each side can crash without losing work |
