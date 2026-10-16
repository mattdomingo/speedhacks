# Validation

Run commands from the repository root. Local tests use fixtures or provider fakes; live Google access, model quality, physical camera recognition, and real calls need separate validation.

## Local checks

Use Node.js 22.15–22.x and Python 3.12+.

| Check | Command | What it covers |
| --- | --- | --- |
| Backend with SQLite | `npm test` | API and MCP contracts, retrieval, authentication, storage, camera processing, reminders, and provider failure handling |
| Camera uploader | `python3 -m unittest discover -s camera -p 'test_*.py'` | Upload limits, timestamps, queue behavior, encoding, and failure recovery |
| Generated analytics | `npm run keewano:codegen -- --check` | Generated code agrees with event definitions, without rewriting it |
| Offline reminder demo | `npm run demo:medicine` | Scheduling, single dispatch, answered calls, and one missed-call fallback using a fake client |

The [CI workflow](../../.github/workflows/check.yml) runs the backend suite with SQLite and Postgres 17, the camera tests, analytics verification, and the offline demo. Consult the actual CI run for results.

## Postgres

Use a disposable database whose user can create schemas and whose connection supports session options:

```sh
TEST_DATABASE_URL=postgres://test:test@127.0.0.1:5432/speedhacks_test npm test
```

The fixtures create and remove a fresh schema per test. Use this test URL only for an isolated local database. SQLite runs skip the two Postgres-only checks.

## iPhone

See [iPhone tests](../../ios/README.md#tests) for the Xcode command and UI walkthrough. Simulator tests and demo screenshots do not establish behavior on a physical iPhone.

## Known gaps

- The repository does not currently include `ios/RecallTests/GoldenSet.json`. The fixture-loading test is skipped, and the live `npm run eval:golden` workflow requires restoring that fixture first.
- The bundled keys photo shows a wooden table rather than the fruit bowl described in its fictional memory. The screenshot demonstrates the card interface; it is not a camera-recognition result.
- Model phrasing, Google consent/sync, and Dial delivery require configured accounts and separate integration checks. Live golden-set evaluation spends provider tokens.
- Camera accuracy needs the [tabletop placement acceptance procedure](../object-memory.md#placement-acceptance). Mock vision results are insufficient.
- User authentication, device provisioning, and operational limits remain prototype concerns; see the [engineering decisions](../../AGENTS.md#decision-log) and [pairing guide](../ios-memory.md).

## Historical evidence

These reports preserve observations from the hackathon and describe the revisions, environments, and limitations recorded at the time:

- [End-to-end report — October 11, 2026](2026-10-11.md)
- [Backend, MCP, and Dial test report](backend.md)
- [Defect log — October 11, 2026](bugs.md)
- [Digital-memory integration validation](../digital-memory-validation.md)
- [Object-memory validation](../object-memory-validation.md)
