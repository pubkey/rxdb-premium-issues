# rxdb-premium-issues

Repo to submit bug reports and test cases for the [RxDB Premium Plugins](https://rxdb.info/premium/)

## How to use it

- Update [this file](./bug-report.test.ts) to reproduce your test scenario
- Run `npm run test:node` to run the test file and ensure it reproduces correctly
- Make a Pull Request with your updated test file.

## Updating RxDB Packages

A CI workflow is available to update `rxdb`, `rxdb-server`, and `rxdb-premium` to their latest versions. It is triggered via a **webhook** (`repository_dispatch`) — no cronjob is used.

### How to trigger the update

Send a `repository_dispatch` event to the GitHub API:

```bash
curl -L \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "Authorization: Bearer <GITHUB_TOKEN>" \
  https://api.github.com/repos/pubkey/rxdb-premium-issues/dispatches \
  -d '{"event_type":"update-rxdb"}'
```

Replace `<GITHUB_TOKEN>` with a personal access token (or GitHub App token) that has **write access** to this repository.

The workflow will:
1. Install the latest versions of `rxdb`, `rxdb-server`, and `rxdb-premium`.
2. If any versions changed, open a pull request with the update.

You can also trigger the workflow manually from the **Actions** tab using the "Run workflow" button (`workflow_dispatch`).
