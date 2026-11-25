# Yuan Translate: Assignment 2 reader guide

Prose word count: 354 (excluding code commands).

## Scope and status

Yuan Translate is an existing web application for lecture transcription, Chinese translation and notes. The site presents source and translated text together and uses the selected subject and relevant text from course materials as context. Audio capture, server relay, translation, lesson history and export are implemented in the repository, subject to service configuration and account access. Uploaded documents are processed as text; images are not interpreted.

The earlier Week 3 two-entry glossary and clarification gate were a manual simulation. The current site is not presented as having that term-level chooser. Translation accuracy, calibrated confidence and reduced classroom distraction are not established.

## Inspecting the work

Open [the public demonstration](https://yuantranslate-classroom.noble-flute-7938.chatgpt.site/) and select **Experience example** / **体验示例**. The preset lesson shows bilingual text and sample notes without using a microphone or calling the model. The repository includes source under `src/`, automated tests under `test/`, and the 20 November software-test report under `docs/`. Online speech and translation require the configured service and suitable access.

To inspect the code locally, install the project's Node dependencies and run the commands below. Automated tests use simulated responses and do not by themselves establish live-service performance.

```sh
npm ci
npm run build
npm test
```

## Development record

- The Week 3 manual walkthrough changed an unsupported default meaning into a request for context. This remains evidence of an early design decision, not a live feature claim.
- [Commit 2a3b554](https://github.com/gengyuan774/yuan-translate/commit/2a3b5542679c04ef62d98f8fc75daf61363916ab) documents recovery of interrupted recordings; [commit d362e2b](https://github.com/gengyuan774/yuan-translate/commit/d362e2b0988201785d9f457dd85fc85ae87eefca) separates ending a recording from requesting a summary.
- [Commit b9319a3](https://github.com/gengyuan774/yuan-translate/commit/b9319a371c5bce151608fb1284a7c237784a9428) syncs the classroom release and adds the dated test report. That report states 342 automated tests passed. Its tests were not rerun during preparation of this guide and do not demonstrate real classroom translation accuracy.

## AI assistance and review

Codex assisted in preparing the Assignment 2 report, diagrams and this reader guide. During preparation, the assistant compared its claims against the existing repository, the published demonstration, the course materials and the dated test report. The demonstration uses preset data and makes no AI call. Earlier development assistance and the student's own decisions and checks should be added here where applicable before submission.
