# The Loan Eligibility Engine
### Engineering Intern Assignment

## 1. Mission

Design, build, and deploy an automated system that ingests user data, discovers personal loan products from public websites, matches users to potentially eligible products, and sends personalized email notifications.

The project evaluates your ability to integrate cloud services with a powerful, self-hosted workflow automation engine.

This is an objective-based assignment. While a framework is provided, creative solutions and architectural decisions that improve performance, reduce cost, and demonstrate a deeper understanding of the problem are highly valued.

## 2. Core Technologies

| Component | Technology |
|---|---|
| Backend language | Python or Go |
| Cloud platform | AWS |
| Compute | AWS Lambda |
| Database | Amazon RDS for PostgreSQL |
| Email service | Amazon SES |
| API layer | API Gateway (optional) |
| Workflow automation | Self-hosted n8n |
| AI integration | An accessible LLM API |
| Infrastructure as Code | Serverless Framework |
| Local deployment | Docker Compose |

**Note:** Paid AI access is not required. Local deployment is acceptable, and a public AWS deployment is a plus but not mandatory. You are not expected to incur cloud costs.

---

## 3. Functional Requirements

### 3.1. Scalable User Data Ingestion

**Objective:** Build a robust mechanism for uploading, processing, and storing user data from a CSV file.

#### Bulk CSV Upload

Design a scalable upload mechanism for CSV files containing user information, such as:

- `user_id`
- `email`
- `monthly_income`
- `credit_score`
- `employment_status`
- `age`

A direct upload through a standard Lambda-backed API Gateway endpoint may encounter request-size limits and execution timeouts.

**Requirement:** Implement a more professional, event-driven ingestion pattern that can handle bulk uploads reliably.

#### Data Persistence

After the CSV is uploaded:

1. Parse and validate the CSV data.
2. Handle invalid records appropriately.
3. Store valid records in a dedicated table in Amazon RDS for PostgreSQL.
4. Track upload or processing status where appropriate.

### 3.2. The n8n Automation Engine

Set up and configure a self-hosted n8n instance using Docker.

All core business logic must be orchestrated through n8n workflows.

The system must include three interconnected workflows.

#### Workflow A: Loan Product Discovery — The Web Crawler

**Goal:** Autonomously discover and store personal loan product information.

**Trigger:** A scheduled workflow, such as a daily execution.

**Process:**

1. Crawl two or three relevant public financial websites.
2. Extract structured information about personal loan products.
3. Capture key details, including:
   - `product_name`
   - `interest_rate`
   - Minimum monthly income
   - Required credit score or credit score range
   - Other relevant eligibility criteria
4. Normalize the extracted information.
5. Store the structured product data in a `loan_products` table in PostgreSQL.

**Optional enhancement:** Handle changes in website layouts and extraction logic.

#### Workflow B: User-Loan Matching — The Eligibility Filter

**Goal:** Match users stored in the database with loan products for which they may qualify.

**Trigger:** A webhook invoked after a new CSV upload has been successfully processed.

**Process:**

1. Fetch the newly added user records from PostgreSQL.
2. Fetch the available loan products and their eligibility criteria.
3. Implement the core matching logic inside n8n.
4. Evaluate users against the loan eligibility criteria.
5. Store successful matches in a `matches` table, linking `user_id` to `product_id`.

#### Creative Challenge: The Optimization Treasure Hunt

**Problem:** Evaluating thousands of users against dozens of loan products can be slow and expensive if an LLM evaluates every user-product pair.

**Task:** Design and implement a multi-stage, optimized filtering pipeline that minimizes unnecessary computation and LLM calls.

Possible approaches include:

- **SQL pre-filtering:** Eliminate products that clearly fail a user's basic eligibility requirements.
- **Rule-based filtering:** Apply deterministic checks for income, credit score, age, and employment status.
- **n8n-based evaluation:** Perform more complex checks only on the remaining candidate pairs.
- **Selective LLM evaluation:** Use an LLM only when qualitative interpretation is genuinely necessary.

Explain your chosen approach, its performance benefits, and its trade-offs in the documentation.

#### Workflow C: User Notification

**Goal:** Notify users about the loan products they have been matched with.

**Trigger:** Execute after Workflow B completes successfully.

**Process:**

1. Identify users with newly created matches.
2. Retrieve their matched loan products.
3. Construct personalized email messages listing products they may qualify for.
4. Send the emails using the AWS SES node in n8n.
5. Handle notification failures and avoid unintended duplicate emails.

**Important testing requirements:**

- Do not email addresses from the sample CSV.
- Use test-inbox aliases such as `abcd+one@gmail.com` and `abcd+two@gmail.com`, replacing `abcd` with your own Gmail username.
- Demonstrate the notification workflow by showing at least one received email in the demonstration video.

---

## 4. User Interface

Build a minimal user interface that allows a user to upload a CSV file containing user data.

This is the primary interaction point for starting the pipeline.

The interface should:

1. Allow the user to select and upload a CSV file.
2. Display upload or processing status.
3. Communicate whether the upload was accepted or failed.
4. Provide a clear indication that downstream processing has been initiated.

---

## 5. Deliverables

### 5.1. GitHub Repository

Create a **private GitHub repository** containing all source code, infrastructure configuration, workflow definitions, and documentation.

Invite the following GitHub users as collaborators:

- `ujjwalkala-clickpe`
- `HarshSrivastav-Dailype`
- `ManishBiswal-clickpe`
- `tushar-clickpe`

### 5.2. Infrastructure and Automation Files

Include the following files:

- `serverless.yml` — AWS infrastructure configuration.
- `docker-compose.yml` — Configuration for launching the self-hosted n8n instance.
- n8n workflow JSON files for Workflows A, B, and C.
- Lambda function source code and supporting backend code.
- Minimal CSV upload UI and related frontend code.
- Database schema or migration files.
- Environment variable examples, without exposing secrets.
- Any additional configuration required to reproduce the system.

### 5.3. Comprehensive Documentation — `README.md`

The README must include:

#### Architecture Diagram

A clear diagram showing how AWS services, the database, the upload interface, and n8n workflows interact.

#### Setup and Deployment

Step-by-step instructions covering:

- Prerequisites and dependencies.
- AWS resource deployment.
- Starting n8n with Docker Compose.
- Database setup and schema initialization.
- Configuring AWS credentials in n8n.
- Configuring PostgreSQL credentials in n8n.
- Configuring the LLM API, if used.
- Importing the workflow JSON files.
- Running the application locally or in the cloud.
- Testing the complete pipeline.

#### Design Decisions

Explain:

- The CSV ingestion architecture and why it scales.
- The web crawling strategy and selected websites.
- How extracted loan products are normalized and stored.
- The user-product matching strategy.
- The **Optimization Treasure Hunt** solution, including how candidate pairs are reduced before expensive processing.
- Failure handling, retries, idempotency, and duplicate prevention.
- Security and credential management.

### 5.4. Demonstration Video

Produce a **5–10 minute** demonstration video.

The video must include:

1. An overview of the architecture.
2. A walkthrough of all three n8n workflows, explaining the logic of each node.
3. A live, end-to-end demonstration of the pipeline.
4. A CSV upload through the UI.
5. Successful persistence of user records in PostgreSQL.
6. Loan product discovery and storage.
7. User-product matching and match persistence.
8. An email received in the test inbox after the pipeline completes.

---

## 6. Submission

Submit the following through the submission form:

- Private GitHub repository link.
- Demonstration video link.

**Deadline:** Within 72 hours of receiving the assignment email.

**Submission form:** [Submit your assignment](https://docs.google.com/forms/d/e/1FAIpQLSe1ET4U8rOcPM3VGJ8fT5HhigTO9fKuDlsB_wHtB5acWys9XQ/viewform)

### Sample Dataset

Use the provided `users.csv` file to test the system.

[Download the sample CSV from Google Drive](https://drive.google.com/file/d/1KBaZRkfr7T2kVBKSr_2fr7v2tTe6f8qu/view?usp=sharing)

---

## 7. Evaluation Criteria

| Category | Maximum Points | Evaluation Focus |
|---|---:|---|
| n8n Workflow Design & Automation | 30 | Workflow sophistication, robustness, efficiency, crawling, data manipulation, and the Optimization Treasure Hunt solution |
| Cloud Architecture & Integration | 20 | AWS serverless design, secure integration, and scalable ingestion |
| Backend Functionality & Code Quality | 30 | Correct ingestion pipeline, clean implementation, modularity, and code quality |
| Documentation & Presentation | 20 | Architecture diagram, setup instructions, design explanations, and demonstration video |
| **Total** | **100** | |

---

## 8. Additional Notes

- The assignment is designed with the expectation that LLMs may assist with architectural design and implementation. However, independent thinking and sound engineering decisions are strongly encouraged.
- You are expected to understand the system you build and be able to explain your architectural choices during evaluation.
- Creative improvements that enhance reliability, efficiency, performance, or cost-effectiveness are welcome.

**Reference:** [Mitchell Hashimoto's post on X](https://x.com/mitchellh/status/2100249348345057389?s=20)

---

## 9. Completion Checklist

### Infrastructure
- [ ] AWS resources configured through `serverless.yml`.
- [ ] PostgreSQL database and schema initialized.
- [ ] Self-hosted n8n configured through Docker Compose.
- [ ] Credentials configured securely.

### Data Ingestion
- [ ] CSV upload UI implemented.
- [ ] Scalable upload mechanism implemented.
- [ ] CSV validation and parsing implemented.
- [ ] User records stored in PostgreSQL.
- [ ] Successful processing triggers Workflow B.

### Workflow A — Product Discovery
- [ ] Scheduled trigger configured.
- [ ] Two or three public financial websites selected.
- [ ] Loan product details extracted and normalized.
- [ ] Product data stored in PostgreSQL.

### Workflow B — Eligibility Matching
- [ ] Newly uploaded users retrieved.
- [ ] Loan products and eligibility criteria retrieved.
- [ ] Multi-stage filtering pipeline implemented.
- [ ] LLM calls minimized or avoided where unnecessary.
- [ ] Matches stored in PostgreSQL.

### Workflow C — Notifications
- [ ] Personalized emails generated.
- [ ] AWS SES integrated with n8n.
- [ ] Test inbox aliases configured.
- [ ] Sample CSV email addresses excluded from testing.
- [ ] At least one received email captured for the demo.

### Documentation and Submission
- [ ] Architecture diagram included.
- [ ] Setup and deployment instructions completed.
- [ ] Design decisions documented.
- [ ] n8n workflow JSON files included.
- [ ] Private GitHub repository created.
- [ ] Required collaborators invited.
- [ ] 5–10 minute demonstration video recorded.
- [ ] Repository and video links submitted through the form.
