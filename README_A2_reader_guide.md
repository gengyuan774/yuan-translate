# Yuan Translate: Assignment 2 reader guide

Prose word count: 505 (excluding code and link destinations).

## Scope and status

Yuan Translate supports lectures through transcription, Chinese translation, selected course materials and notes. Source and translated segments are shown together. Audio capture, server relay, translation, local history and export are implemented, subject to service configuration and access. Imported documents contribute their text layer, not visual interpretation of images.

The earlier Week 3 two-entry glossary and clarification gate were a manual simulation, not an implemented term chooser on this site. Translation accuracy, calibrated confidence and reduced classroom distraction have not been established.

## Technology and inspection

The browser interface is JavaScript with IndexedDB for local data. A Cloudflare-compatible Worker handles server requests; D1 and R2 store account information and lesson content. The source configures OpenAI gpt-transcribe for transcription and gpt-4.1-mini for text generation ([models](https://github.com/gengyuan774/yuan-translate/blob/202e1a12f110c8aa48461a22a600832537a7db74/src/models.js)). Selected material is retrieved as context; the model is instructed not to treat the material as instructions or invent content absent from speech ([prompt](https://github.com/gengyuan774/yuan-translate/blob/202e1a12f110c8aa48461a22a600832537a7db74/src/translation-prompt.js)). These instructions do not guarantee correctness.

Open [the public demonstration](https://yuantranslate-classroom.noble-flute-7938.chatgpt.site/) and select **Experience example / 体验示例**. The preset lesson displays bilingual text and sample notes without a microphone or AI call. For code inspection, Node 22.22.1 was used. From the repository root:

    npm ci
    npm run build
    npm test

Live speech and translation additionally require an appropriately configured server, service credentials, database and account access. An operator must configure their own server-side credentials; never commit an API key or place it in the browser. See the repository [main README](https://github.com/gengyuan774/yuan-translate/blob/main/README.md) for deployment details.

## Development and checks

- The Week 3 manual walkthrough changed an unsupported default meaning into a request for context; the current application instead uses subject and material context.
- [Commit 2a3b554](https://github.com/gengyuan774/yuan-translate/commit/2a3b5542679c04ef62d98f8fc75daf61363916ab) added recovery after interrupted recording, while [d362e2b](https://github.com/gengyuan774/yuan-translate/commit/d362e2b0988201785d9f457dd85fc85ae87eefca) separated stopping recording from requesting a summary. These changes address continuity and user control.
- [Commit b9319a3](https://github.com/gengyuan774/yuan-translate/commit/b9319a371c5bce151608fb1284a7c237784a9428) contains the 20 November test report, which states that 342 tests passed. That complete suite was not rerun for this report.
- On 25 November, Codex reran 32 selected cases from six existing test files using a partial local copy of [commit 202e1a1](https://github.com/gengyuan774/yuan-translate/commit/202e1a12f110c8aa48461a22a600832537a7db74); 32 passed. The copied source and test files were checked against the commit's Git blob hashes. The cases cover reference selection, stopping and summarising, microphone handling, recovery, classroom navigation and save feedback. These are isolated tests with simulated inputs, not a live classroom evaluation:

    node --test test/capture-health.test.mjs test/microphone.test.mjs test/classroom-navigation.test.mjs test/summary-save-feedback.test.mjs test/finish-recording.test.mjs test/cost-optimization.test.mjs

No real lecture user study or live translation accuracy result is claimed. The earlier test report is in the repository's docs folder; no additional ZIP is required.

## Authorship and AI assistance

The student supplied the project and requested publication of the site and repository. Codex assisted with the report, diagrams, this guide and the checks described above. It compared the proposed term-level gate with the existing site and labelled the gate as a simulation; the retry storyboard was marked as a code-based illustration rather than a live-tested screenshot. The existing application predates this report. Any earlier AI assistance and the student's own development decisions and checks still need to be verified by the student before submission.
