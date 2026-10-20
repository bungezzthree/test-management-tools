# Test automation integration

Let your automated tests (JUnit, TestNG, pytest, Playwright, Cypress, Jest, …) **create the test specification** in TestDesk
and **record their results**, with no manual clicking. Results appear in test plans like any manual execution, tagged
🤖 *automated* with build number, CI link and duration, and flow into the SIT / UAT / BAST reports.

## 1. Create an API token

1. Log in as an **admin** or **tester**. Clients cannot create tokens.
2. User menu → **API tokens (CI / automation)** → name it (e.g. `GitHub Actions`), pick an expiry, **Create token**.
3. Copy the token (`tdk_…`). It is shown once; only a hash is stored.

> Tip: as admin, create a dedicated *tester* user such as `ci-bot` and issue the token to it, so results show "CI Bot" as the executor.

A token can **only** call the automation endpoints below (plus `GET /api/auth/me` and `GET /api/projects`). It cannot delete
anything or touch users, settings or reports. Revoke it any time from the same dialog.

Send it on every request: `Authorization: Bearer tdk_…`. The `{project}` in URLs is the project **prefix** (e.g. `CBS`) or its numeric id.

Check the token: `curl -H "Authorization: Bearer $TESTDESK_TOKEN" $TESTDESK_URL/api/auth/me`

## 2. Fastest path: upload a JUnit XML report

Almost every framework can produce JUnit XML. One call creates the missing test cases **and** records the results:

```bash
curl -sS -H "Authorization: Bearer $TESTDESK_TOKEN" \
  -F report=@target/surefire-reports/TEST-all.xml \
  -F plan_name="Nightly regression" -F environment=SIT \
  -F build="$BUILD_NUMBER" -F ci_url="$BUILD_URL" -F run_id="$BUILD_TAG" \
  "$TESTDESK_URL/api/projects/CBS/automation/junit"
```

| Field | Meaning |
|---|---|
| `report` | One or more JUnit XML files (repeat `-F report=@…`) |
| `plan_name` | Test plan to record into. **Reused if it exists, created if not.** Use one name for a rolling plan (`Nightly regression`) or include the build (`Release 2.4 #123`) for a fresh plan per run. Or pass `plan_id`. |
| `environment` | `SIT` or `UAT` (used when the plan is created) |
| `build`, `ci_url` | Shown on each execution; `build` also becomes the plan's build/version |
| `run_id` | Idempotency key. Re-sending the same `run_id` (CI retry) never double-counts |
| `suite_root` | Folder for auto-created cases (default `Automation`) |
| `auto_create` | `false` to only record results for tests that already exist (unknown ones are listed under `unmatched`) |
| `dry_run` | `true` to see what would happen without saving |

How the XML maps:

| JUnit | TestDesk |
|---|---|
| `classname` + `name` | **Automation reference** `classname#name` (the stable key), e.g. `com.bank.LoginTest#validLogin` |
| `classname` | Suite path `Automation / com / bank / LoginTest` |
| `<failure>` / `<error>` | **Failed**, message and stack trace become the *actual result*; console output is attached as `test-output.txt` |
| `<skipped>` | **Skipped** |
| otherwise | **Passed** |
| `time` | Duration |

Optional `<property>` elements on a testcase: `testdesk.ref` (override the reference), `testdesk.defect` (defect id),
`testdesk.requirement` (requirement/Jira key), `testdesk.tags`.

Response (201):

```json
{ "project": "CBS", "plan_id": 7, "plan_name": "Nightly regression", "plan_created": false, "plan_path": "/#/plans/7",
  "recorded": 118, "summary": {"Passed": 112, "Failed": 4, "Blocked": 0, "Skipped": 2},
  "created_cases": [{"automation_ref": "com.bank.NewTest#t", "case_key": "CBS-210"}],
  "unmatched": [], "duplicates": 0, "errors": [] }
```

## 3. Richer control with JSON

### 3a. Sync the test specification from code

Describe your automated tests (objective, steps, priority, requirement) so the specification is meaningful, not just names.
Idempotent: run it on every build; unchanged tests stay unchanged, edited ones get a new version.

```bash
curl -sS -X PUT -H "Authorization: Bearer $TESTDESK_TOKEN" -H "Content-Type: application/json" \
  "$TESTDESK_URL/api/projects/CBS/automation/cases" -d '{
  "suite_root": "Automation",
  "obsolete_missing": false,
  "cases": [
    { "automation_ref": "com.bank.TransferTest#interbankLimit",
      "title": "Interbank transfer is rejected above the limit",
      "suite": "Payments / Transfer",
      "objective": "BI-FAST limit of Rp250.000.000 is enforced",
      "priority": "Critical", "test_type": "Negative", "requirement_ref": "FSD-TRF-03", "tags": "regression",
      "steps": [
        {"action": "Open Transfer > BI-FAST", "expected_result": "Form is displayed"},
        {"action": "Enter amount 300.000.000", "test_data": "300000000", "expected_result": "Error: exceeds limit"}
      ] }
  ] }'
```

- Matching is by `automation_ref`. To **link a test case you already wrote manually**, add `"case_key": "CBS-12"` once; from then on the ref is the key.
- `obsolete_missing: true` marks automated cases that are no longer in the payload as **Obsolete** (they reappear automatically if they come back).
- Cases synced this way get *Execution type = Automated*. Manual edits in the web UI are kept until the next sync overwrites the same fields.
- Add `"dry_run": true` to preview.

### 3b. Record results

```bash
curl -sS -X POST -H "Authorization: Bearer $TESTDESK_TOKEN" -H "Content-Type: application/json" \
  "$TESTDESK_URL/api/projects/CBS/automation/results" -d '{
  "plan": { "name": "Release 2.4 regression", "environment": "UAT", "build_version": "2.4.0" },
  "build": "123", "ci_url": "https://ci.example.com/job/123", "run_id": "job-123",
  "auto_create_cases": true,
  "results": [
    { "automation_ref": "com.bank.TransferTest#interbankLimit", "status": "passed", "duration_ms": 842 },
    { "automation_ref": "com.bank.LoginTest#locked", "status": "failed", "duration_ms": 1530,
      "message": "expected account locked but was active", "defect_ref": "JIRA-9", "output": "…stack trace / console…" }
  ] }'
```

`status` accepts `passed`/`pass`/`success`, `failed`/`fail`/`error`, `skipped`/`pending`, `blocked` (case-insensitive).
Each result may also carry `case_key` instead of `automation_ref`, `notes`, per-step results
(`"steps": [{"step_no": 1, "status": "passed", "actual_result": "…"}]`), and for auto-created cases `title`, `suite`, `requirement_ref`, `tags`, `priority`.
When a test passes, its steps are marked passed too. Up to 5000 items per request (10 MB).

### 3c. Attach screenshots / logs / videos

After posting the result:

```bash
curl -sS -H "Authorization: Bearer $TESTDESK_TOKEN" \
  -F automation_ref="com.bank.LoginTest#locked" -F run_id="job-123" \
  -F evidence=@screenshots/locked.png -F evidence=@videos/locked.mp4 \
  "$TESTDESK_URL/api/plans/7/automation/evidence"
```

## 4. CI recipes

### GitHub Actions

```yaml
- name: Run tests
  run: mvn -B test            # or: pytest --junitxml=junit.xml, npx playwright test --reporter=junit, …
- name: Report to TestDesk
  if: always()                # also report failures
  run: |
    curl -fsS -H "Authorization: Bearer ${{ secrets.TESTDESK_TOKEN }}" \
      -F report=@target/surefire-reports/TEST-all.xml \
      -F plan_name="Regression" -F environment=SIT \
      -F build="${{ github.run_number }}" \
      -F ci_url="${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}" \
      -F run_id="gh-${{ github.run_id }}-${{ github.run_attempt }}" \
      "${{ vars.TESTDESK_URL }}/api/projects/CBS/automation/junit"
```

### Jenkins (declarative)

```groovy
post {
  always {
    junit 'target/surefire-reports/*.xml'
    withCredentials([string(credentialsId: 'testdesk-token', variable: 'TESTDESK_TOKEN')]) {
      sh '''curl -fsS -H "Authorization: Bearer $TESTDESK_TOKEN" \
            -F report=@target/surefire-reports/TEST-all.xml -F plan_name="Regression" \
            -F build="$BUILD_NUMBER" -F ci_url="$BUILD_URL" -F run_id="$BUILD_TAG" \
            "$TESTDESK_URL/api/projects/CBS/automation/junit"'''
    }
  }
}
```

### Frameworks

| Framework | Produce JUnit XML |
|---|---|
| Maven Surefire / Failsafe | automatic: `target/surefire-reports/*.xml` (upload several with repeated `-F report=@…`) |
| Gradle | `build/test-results/test/*.xml` |
| TestNG | `test-output/junitreports/*.xml` |
| pytest | `pytest --junitxml=junit.xml` |
| Playwright | `npx playwright test --reporter=junit` (set `PLAYWRIGHT_JUNIT_OUTPUT_NAME=junit.xml`) |
| Cypress | `--reporter mocha-junit-reporter` |
| Jest | `jest-junit` |
| .NET | `dotnet test --logger "junit;LogFilePath=junit.xml"` (JunitXml.TestLogger) |
| Robot Framework | `robot --xunit junit.xml` |

## 5. Behaviour you can rely on

- **Idempotent.** Test cases are matched by `automation_ref`; send the same `run_id` again and results are not duplicated.
- **Latest result wins.** A plan shows each test's most recent execution; older runs stay in the execution history.
- **Closed plans** reject new results (409). **Obsolete** cases are not run; sync them again to revive.
- **Partial success.** Bad items are reported in `errors` with their index; good items are still recorded. Request-level problems (unknown project, closed plan, invalid XML) return an HTTP error and record nothing.
- **UAT.** Automated results in a UAT plan still need client approval like any other result.
- Errors are JSON: `{ "error": "message" }`. `401` bad/expired token, `403` token used outside automation or user lacks the role, `404` unknown project/plan, `409` conflict, `413` too many items.

## 6. Importing from Excel/CSV

The import/export layout has an **Automation Ref** column, so you can also link existing manual cases to code from a spreadsheet.
