# Changelog

All notable changes to [Claudish](https://github.com/MadAppGang/claudish).

## [5.17.0] - 2026-03-20

### Bug Fixes

- release.yml heredoc syntax for GitHub Actions YAML parser([`3265a74`](https://github.com/MadAppGang/claudish/commit/3265a748fa2b5e760a6f898635ff71ffb58819f4))

### New Features

- v5.17.0 - automatic changelog generation with git-cliff([`c7caef9`](https://github.com/MadAppGang/claudish/commit/c7caef9987d55d2b0bb3728c77b06cb62925e7ee))

## [5.16.2] - 2026-03-20

### Bug Fixes

- v5.16.2 - target correct tmux pane for diag split([`e328d6b`](https://github.com/MadAppGang/claudish/commit/e328d6bc3fd0de6f95bdb962623ef55d3c5a41bf))

## [5.16.1] - 2026-03-20

### Refactoring

- v5.16.1 - single source of truth for provider definitions, fix adapter matching([`072697b`](https://github.com/MadAppGang/claudish/commit/072697bf7405f6cc47a655b8c0188cb79528efdc))
- single source of truth for provider definitions + fix adapter matching (#82)([`7fb091d`](https://github.com/MadAppGang/claudish/commit/7fb091d1ff4dcd3a7177f1b37f7efa50d4721779))

## [5.16.0] - 2026-03-20

### New Features

- v5.16.0 - DiagOutput for clean diagnostic display([`b8f82d8`](https://github.com/MadAppGang/claudish/commit/b8f82d87dc09aca56fd0945e8e2a8d4f34602ea2))
- DiagOutput — separate claudish diagnostics from Claude Code TUI([`e53b7fc`](https://github.com/MadAppGang/claudish/commit/e53b7fcc46afcd1923fefdbe8aba160dad5069ef))

## [5.15.0] - 2026-03-19

### Bug Fixes

- include team-cli and mcp-server files needed for CI build([`723a1e9`](https://github.com/MadAppGang/claudish/commit/723a1e9ed2a4878d9f0463160221c9388da3e935))
- preserve real auth credentials when native Claude models are in config([`f356328`](https://github.com/MadAppGang/claudish/commit/f356328f302098eb9fb0a69751b0f35021ba8c33))

### Documentation

- update CLAUDE.md with 3-layer architecture and debug-logs workflow([`b8dce83`](https://github.com/MadAppGang/claudish/commit/b8dce83c3f1772f658387943f64e3c8c3eb144d9))

### New Features

- v5.15.0 - XiaomiAdapter, dynamic OpenRouter context windows, fix all hardcoded context sizes([`bff916c`](https://github.com/MadAppGang/claudish/commit/bff916cd27f3e384404d80085174267ea7c340c1))
- always-on structural logging without --debug([`2f1b284`](https://github.com/MadAppGang/claudish/commit/2f1b284e8328146d5c7c96a5af8862992b79bb39))

## [5.14.0] - 2026-03-18

### Bug Fixes

- upgrade MCP SDK to ^1.27.0 to fix Zod 4 tool schema serialization([`951963c`](https://github.com/MadAppGang/claudish/commit/951963cec7880686ac2a71117ecd0fe44abfc88b))
- add ToolSearch to tool-call-recovery inference (#63)([`5a2afcf`](https://github.com/MadAppGang/claudish/commit/5a2afcfb2a3aab1f8d22f84bb04bc3b243444e7a))
- resolve spawn EINVAL on Windows when Claude binary is a .cmd file (#67)([`e511efa`](https://github.com/MadAppGang/claudish/commit/e511efa0f94b01ef36d6955032684184ea9df14d))

### New Features

- v5.14.0 - adapter architecture rearchitecture with 3-layer separation([`871f338`](https://github.com/MadAppGang/claudish/commit/871f3387c6e68dba4b3820aa711aaa6f3bcb3bb2))

## [5.13.4] - 2026-03-18

### Bug Fixes

- v5.13.4 - suppress stderr during interactive Claude Code sessions([`7cdf94d`](https://github.com/MadAppGang/claudish/commit/7cdf94d5b3c842c088ed625de26b62c8d18575d2))

## [5.13.3] - 2026-03-18

### Bug Fixes

- v5.13.3 - clean error display and openrouter/ native prefix support([`af2daec`](https://github.com/MadAppGang/claudish/commit/af2daec0cc6afee0c8b6ac98267e81c16a01df1d))

## [5.13.2] - 2026-03-18

### Bug Fixes

- v5.13.2 - recognize openrouter/ vendor prefix in model parser([`2e3d0fc`](https://github.com/MadAppGang/claudish/commit/2e3d0fc2db673f2446482253185f8af51d11bcf1))

## [5.13.1] - 2026-03-16

### Bug Fixes

- v5.13.1 - use Zen Go (subscription) instead of Zen (credits) in default fallback chain([`b610462`](https://github.com/MadAppGang/claudish/commit/b6104628906722173a311f30c475282b9fc26c4e))

## [5.13.0] - 2026-03-16

### New Features

- v5.13.0 - anonymous usage stats with OTLP format([`ca0d015`](https://github.com/MadAppGang/claudish/commit/ca0d015c4d03f5456b89aac3720605067c38a40b))

## [5.12.3] - 2026-03-16

### Bug Fixes

- v5.12.3 - Node.js launcher with Bun detection([`5c8a99b`](https://github.com/MadAppGang/claudish/commit/5c8a99be6a3ecbc02d9c32ce745cbb45d579ab3b))

## [5.12.2] - 2026-03-16

### Bug Fixes

- v5.12.2 - switch from Node to Bun runtime target([`5e85801`](https://github.com/MadAppGang/claudish/commit/5e858010ff31ee4db2aeadb319a857f676379453))

## [5.12.1] - 2026-03-16

### Bug Fixes

- v5.12.1 - exclude OpenTUI bun:ffi from Node bundle([`a0150ea`](https://github.com/MadAppGang/claudish/commit/a0150ead59f4eb8ad5ede4b610a7a742f7a46790))

## [5.12.0] - 2026-03-16

### Bug Fixes

- update landing page with brew install and v5.11.0 badge([`00438ee`](https://github.com/MadAppGang/claudish/commit/00438ee856a6e4988dcab8c506195a2470999b4a))
- add "no healthy deployment" to retryable errors for LiteLLM fallback([`8bdff19`](https://github.com/MadAppGang/claudish/commit/8bdff19d3b8c86924ecdc895c35e04bee2167acc))
- dynamically fetch top models from OpenRouter API([`71f5b1d`](https://github.com/MadAppGang/claudish/commit/71f5b1d501a5aa381cb32b4342d06c4255292646))
- use canonical homebrew-tap repo name in CI([`ca3053f`](https://github.com/MadAppGang/claudish/commit/ca3053fcabb83acff90c47ece10706cc93ceb11d))

### New Features

- v5.12.0 - LiteLLM fallback fix, dynamic top models([`37f27e4`](https://github.com/MadAppGang/claudish/commit/37f27e410ca6ecc9418ccb2a06c3d8827295dc90))

## [5.11.0] - 2026-03-15

### Bug Fixes

- skip vision probe for glm (glm-5 is text-only) *(smoke)* ([`cb8660c`](https://github.com/MadAppGang/claudish/commit/cb8660c912089d192c17d7016502d867ce4cb436))

### New Features

- v5.11.0 - config TUI, API key storage, Homebrew tap migration([`5de8c2c`](https://github.com/MadAppGang/claudish/commit/5de8c2ce4de5bc22b30519bc8f9d7d063d246d18))

## [5.10.0] - 2026-03-15

### Bug Fixes

- revert minimax supportsVision to true, skip in smoke only *(smoke)* ([`92a8d1a`](https://github.com/MadAppGang/claudish/commit/92a8d1aeab738b13d612e77a53c8508a084619d6))
- glm-coding representative model codegeex-4 → glm-5 *(smoke)* ([`a6c0b6e`](https://github.com/MadAppGang/claudish/commit/a6c0b6ebae0564d174beae05613c9a956fb4891b))
- fix zen-go reasoning, enable glm-coding, fix minimax vision *(smoke)* ([`534053f`](https://github.com/MadAppGang/claudish/commit/534053f0bf0bc2aef2bfdb785177134ab61fd0a0))
- re-enable minimax provider (balance topped up) *(smoke)* ([`3526ba5`](https://github.com/MadAppGang/claudish/commit/3526ba5a78b0ea04df87bb9dab757cc041daf663))
- skip minimax provider (redundant with minimax-coding) *(smoke)* ([`d253a5a`](https://github.com/MadAppGang/claudish/commit/d253a5a1246990dced5668965425f58847c4ae1a))
- add LITELLM_BASE_URL to smoke test workflow env *(smoke)* ([`795df6b`](https://github.com/MadAppGang/claudish/commit/795df6bbdfce33ac34d6a46b450103e9369c8f56))

### Documentation

- update landing page hero version to v5.9.0([`aa0bd65`](https://github.com/MadAppGang/claudish/commit/aa0bd651c2ed3903819f3ce3b449950e3334a1f2))

### New Features

- v5.10.0 - custom routing rules, 429 retryable, smoke test fixes([`e38af0e`](https://github.com/MadAppGang/claudish/commit/e38af0e526421de555a4d96c75d08291911a5aba))

## [5.9.0] - 2026-03-14

### Bug Fixes

- fix tool probe, opencode-zen model, minimax-coding vision *(smoke)* ([`5072d5b`](https://github.com/MadAppGang/claudish/commit/5072d5b1eefca16bcffccf1bb81611c9e46d0610))
- litellm representative model → gemini-2.5-flash (gpt-4o-mini not deployed) *(smoke)* ([`b2bb925`](https://github.com/MadAppGang/claudish/commit/b2bb925208fb89bc4942e055924c33ea080d6210))

### New Features

- v5.9.0 - provider fallback chain for auto-routed models([`dfb60dd`](https://github.com/MadAppGang/claudish/commit/dfb60dd01055a87adef9ad12fcdb71345c0f7dd1))

## [5.8.0] - 2026-03-06

### New Features

- v5.8.0 - periodic smoke test suite for all providers([`df24c7d`](https://github.com/MadAppGang/claudish/commit/df24c7d7dcd803cb803d4ea59f930e56e7ef5275))

## [5.7.1] - 2026-03-06

### Bug Fixes

- v5.7.1 - strip tool_reference blocks; fix qwen OpenRouter vendor prefix([`b8ea099`](https://github.com/MadAppGang/claudish/commit/b8ea099efcad1fdfb7036cb0519e348f87731c9f))

### Documentation

- v5.7.0 - update README and CHANGELOG for Zen Go provider([`f3cef40`](https://github.com/MadAppGang/claudish/commit/f3cef403c3bece598bade12f6b482d92cbd0bd01))

## [5.7.0] - 2026-03-06

### New Features

- v5.7.0 - add OpenCode Zen Go provider (zgo@) with live model discovery([`10afe39`](https://github.com/MadAppGang/claudish/commit/10afe39531a2b76cc63c8e1cf46713602eb278e6))

## [5.6.1] - 2026-03-05

### Bug Fixes

- v5.6.1 - fix MiniMax direct API auth (Bearer vs x-api-key)([`74d1f84`](https://github.com/MadAppGang/claudish/commit/74d1f842023fe7285d56c510fee72888b404346b))
- switch direct API auth from x-api-key to Authorization: Bearer *(minimax)* ([`0d96b8c`](https://github.com/MadAppGang/claudish/commit/0d96b8c86fd5eb55dcece4dbc810538b279d2464))

## [5.6.0] - 2026-03-05

### New Features

- v5.6.0 - auto-resolve vendor prefixes for OpenRouter and LiteLLM([`8703b2a`](https://github.com/MadAppGang/claudish/commit/8703b2a083269a45a798f2cebea2f135f4e9a3d0))

## [5.5.2] - 2026-03-03

### Bug Fixes

- v5.5.2 - truncateContent crash on undefined content([`3c047ca`](https://github.com/MadAppGang/claudish/commit/3c047ca94d9978756004ab8796382829af06fe58))

## [5.5.1] - 2026-03-03

### Bug Fixes

- v5.5.1 - consolidate duplicate update command into single path([`7bdfa14`](https://github.com/MadAppGang/claudish/commit/7bdfa147d0473a74971204b88ceae344ed9254c0))

## [5.5.0] - 2026-03-03

### New Features

- v5.5.0 - provider-agnostic recommended models and GLM adapter([`ccde45b`](https://github.com/MadAppGang/claudish/commit/ccde45b43a34b5b9ed3698f356ef611f09b47231))

## [5.4.1] - 2026-03-03

### Bug Fixes

- v5.4.1 - monitor mode no longer sets invalid model name([`956f513`](https://github.com/MadAppGang/claudish/commit/956f513fd179519640e07ea7bbd31a01af8f3e1d))
- monitor mode no longer sets ANTHROPIC_MODEL="unknown"([`f333e11`](https://github.com/MadAppGang/claudish/commit/f333e1156d0aa708eed1699f309e564f4ebd057c))

## [5.4.0] - 2026-03-03

### New Features

- v5.4.0 - anonymous error telemetry with opt-in consent([`5ac3df1`](https://github.com/MadAppGang/claudish/commit/5ac3df1b9309d9ed8152484ba92a7e57be0f5a7c))

## [5.3.1] - 2026-03-02

### Bug Fixes

- v5.3.1 - provider error visibility and quiet suppression([`066d058`](https://github.com/MadAppGang/claudish/commit/066d058c1cf20a53d8ba9e6c6db17bd146a85fca))

## [5.3.0] - 2026-03-02

### New Features

- v5.3.0 - Claude Code flag passthrough([`8422c59`](https://github.com/MadAppGang/claudish/commit/8422c59e85095669df516bdf52e049d9d6e694ca))

## [5.2.0] - 2026-02-26

### New Features

- v5.2.0 - auto model routing without provider prefix([`cabcef3`](https://github.com/MadAppGang/claudish/commit/cabcef3b14afb26654676cbf7b04f8062f6e04ea))

## [5.1.2] - 2026-02-25

### Bug Fixes

- v5.1.2 - fix landing page CI deploy (bun lockfile, Firebase project ID)([`63a9c4f`](https://github.com/MadAppGang/claudish/commit/63a9c4f03615baeda614483f05009a109f0e3c9e))
- use bun instead of pnpm for landing page deploy, correct Firebase project ID([`ff34904`](https://github.com/MadAppGang/claudish/commit/ff349040609f2009b585017cd180154ccdfce183))

## [5.1.1] - 2026-02-25

### Bug Fixes

- include LiteLLM models in --models search and listing([`06ee4e6`](https://github.com/MadAppGang/claudish/commit/06ee4e6eea9b9b2177a8266a4c19409da547b59c))
- v5.1.1 - unset CLAUDECODE env var for nested session compatibility([`9c62ca9`](https://github.com/MadAppGang/claudish/commit/9c62ca97b6c6f30ea165b1ff6aace32c3eedff56))
- v5.1.0 - landing page vision section, Gemini pricing, lint fixes([`bf9ac8c`](https://github.com/MadAppGang/claudish/commit/bf9ac8cc4238f9ee5eaee3aee120c520e3b74940))

### Documentation

- add vision proxy section to README([`0029cde`](https://github.com/MadAppGang/claudish/commit/0029cdedd20776e5b889ec60de4361ea05db9647))

### New Features

- add Changelog section to landing page with auto-deploy on release([`8aa64a7`](https://github.com/MadAppGang/claudish/commit/8aa64a77fec4a78f702b030504b1c6c43f5cdeeb))
- auto-generate structured release notes from conventional commits([`ada936f`](https://github.com/MadAppGang/claudish/commit/ada936fe3a011394b3867296773d775df7320a21))

## [5.1.0] - 2026-02-19

### New Features

- v5.1.0 - vision proxy for non-vision models([`355bbb0`](https://github.com/MadAppGang/claudish/commit/355bbb063903f473d23f31a9c4503a6226a4d91a))

## [5.0.0] - 2026-02-18

### New Features

- v5.0.0 - composable handler architecture, minimax-coding provider([`fdcadd5`](https://github.com/MadAppGang/claudish/commit/fdcadd51eac54d27eab34b3b6be9cee29db5cce8))

## [4.6.11] - 2026-02-16

### Bug Fixes

- v4.6.11 - sync reasoning_content fix to packages/cli([`0b46f87`](https://github.com/MadAppGang/claudish/commit/0b46f87857cc93ba9fcffa93f0f0f5b2546fe686))

## [4.6.10] - 2026-02-16

### Bug Fixes

- v4.6.10 - handle reasoning_content for Kimi thinking models via LiteLLM([`8af631c`](https://github.com/MadAppGang/claudish/commit/8af631cce5dac500ae1e6185503c141b9d0324b0))

## [4.6.9] - 2026-02-15

### Bug Fixes

- v4.6.9 - force-update clears all model caches, add --list-models alias([`618db96`](https://github.com/MadAppGang/claudish/commit/618db96fea42dec51c0c421533ad02e47e1932c3))
- add User-Agent header for Kimi models via LiteLLM([`6758f21`](https://github.com/MadAppGang/claudish/commit/6758f211dbd994d2a1e2369acf324746b3dd75d8))
- convert image_url to inline base64 for MiniMax via LiteLLM([`6be13ee`](https://github.com/MadAppGang/claudish/commit/6be13eebb66d90ca45cef93d0aa6131bab83782e))

## [4.6.8] - 2026-02-14

### Bug Fixes

- v4.6.8 - sync LiteLLM handler to packages/cli for npm publish([`7d27f2d`](https://github.com/MadAppGang/claudish/commit/7d27f2dead831a67bee768e1fdb540a5a5285fcf))

## [4.6.7] - 2026-02-14

### Bug Fixes

- v4.6.7 - strip images for non-vision GLM models([`e8b676e`](https://github.com/MadAppGang/claudish/commit/e8b676e57121fb8819850aa5a8879dcf325448ab))

## [4.6.6] - 2026-02-13

### Bug Fixes

- v4.6.6 - use Promise.allSettled for provider fetches([`130a00f`](https://github.com/MadAppGang/claudish/commit/130a00fe2e31839ea880073cab8a2098518e9fe8))

## [4.6.5] - 2026-02-13

### New Features

- v4.6.5 - interactive provider filter in model selector([`a937998`](https://github.com/MadAppGang/claudish/commit/a9379989eb0f6913f5a9f0d64348edff270e3e4e))

## [4.6.4] - 2026-02-13

### New Features

- v4.6.4 - add @provider filter to interactive model search([`8631bf0`](https://github.com/MadAppGang/claudish/commit/8631bf08605da02aa12834e971f0c7ffc04eada0))

## [4.6.3] - 2026-02-13

### Bug Fixes

- v4.6.3 - remove silent provider fallback, fix LiteLLM endpoint([`1b30325`](https://github.com/MadAppGang/claudish/commit/1b30325c416a54b436c622db24e97a54e93e1cde))

## [4.6.2] - 2026-02-13

### Bug Fixes

- v4.6.2 - sync LiteLLM model discovery to packages/cli for npm publish([`1db5432`](https://github.com/MadAppGang/claudish/commit/1db5432c305fc72d9f0210eb7a70155f9ee9f7aa))

## [4.6.1] - 2026-02-12

### Bug Fixes

- v4.6.1 - model routing and self-update fixes([`0b972e3`](https://github.com/MadAppGang/claudish/commit/0b972e36526b01131caa30b5001a771f2d8a27a3))

### Documentation

- update CLAUDE.md with version bump checklist and LiteLLM shortcut([`4bb7ea3`](https://github.com/MadAppGang/claudish/commit/4bb7ea32f39d5b0d5d970b9e05943cdc0226a99b))

## [4.6.0] - 2026-02-12

### Bug Fixes

- update packages/cli/package.json version to 4.6.0([`20d4fb7`](https://github.com/MadAppGang/claudish/commit/20d4fb77751ed22cfe4d5471e7cb394f120b27dd))

### New Features

- v4.6.0 - LiteLLM provider support([`fdf3719`](https://github.com/MadAppGang/claudish/commit/fdf371948c737ef85ecf9fbd60170d4fffe61403))

## [4.5.3] - 2026-02-12

### New Features

- v4.5.3 - OllamaCloud/GLM model discovery, fuzzy search improvements([`bdd27e5`](https://github.com/MadAppGang/claudish/commit/bdd27e5437d470953cfa0faeccca7635b0202db0))

## [4.5.2] - 2026-02-12

### New Features

- v4.5.2 - GLM Coding Plan provider, local/global profiles, landing page updates([`dda1c3a`](https://github.com/MadAppGang/claudish/commit/dda1c3aadb361b847dc89744ebcb41424fc91d6c))

## [4.5.1] - 2026-02-09

### New Features

- v4.5.1 - Kimi Coding provider sync and model updates([`5575ea6`](https://github.com/MadAppGang/claudish/commit/5575ea6732fd3192da2ab5f6ac98bd18b053ad45))

## [4.5.0] - 2026-02-06

### New Features

- v4.5.0 - Profile-based model routing and dynamic status line([`e0aa3eb`](https://github.com/MadAppGang/claudish/commit/e0aa3ebb76335161f075f41d035f1365cc587bad))

## [4.4.5] - 2026-02-03

### New Features

- v4.4.5 - Progress bar for context display, Vertex routing fix([`25d70ba`](https://github.com/MadAppGang/claudish/commit/25d70baa233e6d3ba3d8e8d96e0d3e42420aa212))

## [4.4.4] - 2026-02-03

### Bug Fixes

- v4.4.4 - Use models.dev API for accurate OpenAI context windows([`c85dddf`](https://github.com/MadAppGang/claudish/commit/c85dddf3a16ea3a8f915d4339da4e481aa667845))

### Other Changes

- add original OG image for landing page([`796d4a0`](https://github.com/MadAppGang/claudish/commit/796d4a0347b10136d6dca93fbac629797a7f9762))

## [4.4.3] - 2026-01-30

### Bug Fixes

- v4.4.3 - Add missing getToolNameMap method and tool-name-utils([`f9e885b`](https://github.com/MadAppGang/claudish/commit/f9e885bf6b28f001bcf578a32194942b1526b2fa))

## [4.4.2] - 2026-01-30

### Bug Fixes

- v4.4.2 - Fix update command with -y flag alias([`fe3f280`](https://github.com/MadAppGang/claudish/commit/fe3f28057655a07f35fd505b380607d84dbd492d))

## [4.4.1] - 2026-01-30

### New Features

- v4.4.1 - Add claudish update command([`ae44988`](https://github.com/MadAppGang/claudish/commit/ae449880d8f2d2ecc18c17f333e18b66f79b4954))

## [4.4.0] - 2026-01-30

### New Features

- v4.4.0 - Interactive model selector improvements([`89fd34e`](https://github.com/MadAppGang/claudish/commit/89fd34e1a53a02af3b099e99b531f45c061da0c1))

## [4.3.1] - 2026-01-30

### New Features

- v4.3.1 - SEO improvements and multi-provider documentation([`74a73b9`](https://github.com/MadAppGang/claudish/commit/74a73b94b2b52bdfd0cb6e5e39fce32383a4d042))

## [4.3.0] - 2026-01-30

### Bug Fixes

- sync packages/cli version to 4.3.0([`02700dd`](https://github.com/MadAppGang/claudish/commit/02700ddf5fc463908acaf62f619754dab1a795fc))

### New Features

- v4.3.0 - Add --stream flag for NDJSON streaming output([`7b2403b`](https://github.com/MadAppGang/claudish/commit/7b2403b1a37d8c3c447f378af5c8e13f0c7ab0ad))

## [4.2.2] - 2026-01-30

### Bug Fixes

- profile flag now skips model selector, Gemini tool name sanitization([`f97271d`](https://github.com/MadAppGang/claudish/commit/f97271dfc3491b3e79fd512e6c872f96c7d5c59b))

## [4.2.1] - 2026-01-30

### Bug Fixes

- update xAI model references to use latest Grok 4.1 models([`40f5fb2`](https://github.com/MadAppGang/claudish/commit/40f5fb29c9b584b78f8791496de72861a7a9a78a))

## [4.2.0] - 2026-01-30

### Bug Fixes

- support Anthropic subscription auth in monitor mode *(monitor)* ([`8f4fb3c`](https://github.com/MadAppGang/claudish/commit/8f4fb3c8f310e3fbff20e79bfa03b07de598ee95))

### New Features

- v4.2.0 - Add direct xAI/Grok API support and multi-provider model selector([`78bd21d`](https://github.com/MadAppGang/claudish/commit/78bd21d9221bde6cee33cd368584bf0236dfd191))

## [4.1.1] - 2026-01-28

### Bug Fixes

- use ~/.claudish/ for models cache in standalone binaries([`05583f5`](https://github.com/MadAppGang/claudish/commit/05583f5f490c5fc256f76ace76aff2e9533cbbb6))

## [4.1.0] - 2026-01-28

### Bug Fixes

- implement --gemini-login and --gemini-logout CLI flags([`ea6a5f0`](https://github.com/MadAppGang/claudish/commit/ea6a5f05f4840d1a9ff610a6f3b260c820b51129))

### New Features

- v4.1.0 - Dynamic pricing and status line improvements([`bb59b06`](https://github.com/MadAppGang/claudish/commit/bb59b06b814ee0484fff81baa92289152988f2b4))

### Other Changes

- remove AI session artifacts and legacy lockfiles([`4cb76fb`](https://github.com/MadAppGang/claudish/commit/4cb76fb3065c54cd30ada59ce900bd946f445d6b))

## [4.0.6] - 2026-01-26

### Bug Fixes

- use correct bun command for global package updates *(update)* ([`a7eee57`](https://github.com/MadAppGang/claudish/commit/a7eee579b3497132652e6bbeb4cc643c8faeb89e))

## [4.0.5] - 2026-01-26

### Bug Fixes

- model switching and role mappings now work correctly([`40fc939`](https://github.com/MadAppGang/claudish/commit/40fc939b05e05f870ea38c93dfdb0a43a4ab177d))

## [4.0.4] - 2026-01-26

### Bug Fixes

- don't skip permissions by default (safer behavior)([`54293f2`](https://github.com/MadAppGang/claudish/commit/54293f20d0a433156221d5b2e845ffab2fc8e293))

## [4.0.3] - 2026-01-26

### Bug Fixes

- improve Termux/Android support *(android)* ([`5b8e14d`](https://github.com/MadAppGang/claudish/commit/5b8e14dcb8bf26bf557dbd04862a2c5be988123d))

## [4.0.2] - 2026-01-26

### Bug Fixes

- use claude.cmd instead of claude shell script *(windows)* ([`18ae794`](https://github.com/MadAppGang/claudish/commit/18ae794699ef31f62876cec5f22052bed9b6ea85))

## [4.0.1] - 2026-01-26

### Bug Fixes

- explicit provider routing for all CLI commands([`87c4ae0`](https://github.com/MadAppGang/claudish/commit/87c4ae0e494888f9a7f1794d67633f65d0d569d5))

## [4.0.0] - 2026-01-26

### Bug Fixes

- make build work without private markdown file([`ba5427c`](https://github.com/MadAppGang/claudish/commit/ba5427cb387317283ab36c0f88c92a6bbd5096f2))

### New Features

- v4.0.0 - New provider@model routing syntax([`f16caf4`](https://github.com/MadAppGang/claudish/commit/f16caf4c06c0140accf5c7d5aa5af8d552442afc))
- auto-update recommended models on release([`e1cd5e4`](https://github.com/MadAppGang/claudish/commit/e1cd5e4ffc4587b31a74d02eccbb6cf28cf64fbf))

### Other Changes

- remove all references to shared/recommended-models.md([`98d106d`](https://github.com/MadAppGang/claudish/commit/98d106d1d5f5623307b98f7ff0cc44881bcf1ffb))

### Refactoring

- remove obsolete extract-models.ts system([`08a044c`](https://github.com/MadAppGang/claudish/commit/08a044cf9c1d9eea4dd2df227511349d5f00b051))

## [3.11.0] - 2026-01-25

### Bug Fixes

- sync workspace package versions to 3.10.0([`36eea9d`](https://github.com/MadAppGang/claudish/commit/36eea9d8ed2fc6521fb42fd7d7622e245546bd06))

### Documentation

- add Z.AI to help text([`9524a0c`](https://github.com/MadAppGang/claudish/commit/9524a0cee5d3bcbc223b92e8138b3ff713e3d275))

### New Features

- v3.11.0 - local model concurrency queue([`d51755e`](https://github.com/MadAppGang/claudish/commit/d51755e34a54cb0fb982861cbb105f2b41d968e2))

## [3.10.0] - 2026-01-25

### Bug Fixes

- route google/ and openai/ to OpenRouter, add tests([`a29087c`](https://github.com/MadAppGang/claudish/commit/a29087cf4c27f727af3d3856977f1c30ed54de74))
- API key precedence and provider resolution (#38)([`5d7d3a9`](https://github.com/MadAppGang/claudish/commit/5d7d3a940dcd7e4812846ee7f0cabbc623cbb802))
- package.json scripts (#37)([`017ce5e`](https://github.com/MadAppGang/claudish/commit/017ce5e21fbd97aa34168b02b7305b33186b0bb4))

### New Features

- v3.10.0 - add Z.AI direct provider and fix GLM reasoning([`a6d259e`](https://github.com/MadAppGang/claudish/commit/a6d259e79867d64b9f36de6c17f7c4e2afb4af42))

## [3.9.0] - 2026-01-24

### New Features

- v3.9.0 - rate limiting queue and improved error handling([`eda8b0e`](https://github.com/MadAppGang/claudish/commit/eda8b0e768eea99e2760ad338d56268eead1bf5a))

## [3.8.0] - 2026-01-23

### Bug Fixes

- sync src/ with packages/ for OpenCode Zen support([`4a22f08`](https://github.com/MadAppGang/claudish/commit/4a22f087fd7b1493381a9c57ce00cae3d5a10097))
- show FREE in status line for OpenRouter free models([`a1397e6`](https://github.com/MadAppGang/claudish/commit/a1397e619822e06c7061131ae47e247220c39d33))
- filter --free models to only show those with tool support([`47c6026`](https://github.com/MadAppGang/claudish/commit/47c6026ff7a4e3a0b16f3bea478c04fa2e2fe0d8))
- show FREE in status line for free zen/ models([`cdfc913`](https://github.com/MadAppGang/claudish/commit/cdfc9134a1aa6be7fa29869874d40af1b5c186ed))
- use correct pricing for zen/ free models([`a1ece06`](https://github.com/MadAppGang/claudish/commit/a1ece06d51c0039e59d703aa16a2b70aca035061))
- show correct provider name in status line for zen/ models([`4b0d81d`](https://github.com/MadAppGang/claudish/commit/4b0d81d9e282ac3121be2fbac60bb6c8b1de8712))
- zen/ provider skip auth header for free models([`e704671`](https://github.com/MadAppGang/claudish/commit/e7046715f82f5de640dcc2009bfc58d7a04ed8fe))

### New Features

- friendly error messages for OpenRouter API errors([`d920585`](https://github.com/MadAppGang/claudish/commit/d920585f6f51f63645f267169141de8f0922f1a7))
- add rate limiting queue for OpenRouter API([`ac46c00`](https://github.com/MadAppGang/claudish/commit/ac46c00cadafdf1ffe3f3181b625f32f3d28ac10))
- v3.8.0 - add OpenCode Zen provider (zen/ prefix)([`3568c3a`](https://github.com/MadAppGang/claudish/commit/3568c3a5fe8d4338b2f23459db176e44e0b56fe7))

## [3.7.9] - 2026-01-23

### Bug Fixes

- v3.7.9 - check all model slots for API key requirement([`568610a`](https://github.com/MadAppGang/claudish/commit/568610a7348f3fe8c9e50ec638e2380196d1650d))

## [3.7.8] - 2026-01-23

### New Features

- v3.7.8 - skip OpenRouter API key for local models([`382e741`](https://github.com/MadAppGang/claudish/commit/382e741457aadf68598ec968dd53129777534928))

## [3.7.7] - 2026-01-23

### Bug Fixes

- v3.7.7 - fix package.json not found in compiled binaries([`503897f`](https://github.com/MadAppGang/claudish/commit/503897fdd9d4986c6d6d58121247bb3a3a858ef7))

## [3.7.6] - 2026-01-23

### Bug Fixes

- v3.7.6 - improve Claude Code detection on Mac([`6566d96`](https://github.com/MadAppGang/claudish/commit/6566d964cdfd8e918e19cc8e1e74cb33cbd8fbc5))

## [3.7.5] - 2026-01-23

### Bug Fixes

- v3.7.5 - bypass Claude Code login screen in interactive mode([`350f48c`](https://github.com/MadAppGang/claudish/commit/350f48cee2d0b6265e572a137674745f6d09a703))

## [3.7.4] - 2026-01-23

### Bug Fixes

- v3.7.4 - support local Claude Code installations([`54fb39c`](https://github.com/MadAppGang/claudish/commit/54fb39c32b00c72463b6269d225122f40c8892f6))

## [3.7.3] - 2026-01-22

### New Features

- v3.7.3 - dynamic provider and model name in status line([`3e413fc`](https://github.com/MadAppGang/claudish/commit/3e413fcb47ae321480b0cd27d669a21d0568fb49))

## [3.7.2] - 2026-01-22

### Bug Fixes

- v3.7.2 - show FREE for OAuth sessions, ~$ for estimated pricing([`605c589`](https://github.com/MadAppGang/claudish/commit/605c589fc9a0ad827c10ab701385bbd1a5d4ce9c))

## [3.7.1] - 2026-01-22

### Bug Fixes

- v3.7.1 - type coercion for local model tool arguments([`a3fddd6`](https://github.com/MadAppGang/claudish/commit/a3fddd647265019494a10d25fb760328c3f8eb29))
- add type coercion for tool arguments from local models (#30)([`23ca258`](https://github.com/MadAppGang/claudish/commit/23ca25850b9c4711d1c2fa42e7c1c612fb7fa16c))

## [3.7.0] - 2026-01-22

### New Features

- v3.7.0 - Gemini Code Assist OAuth support with rate limiting([`687b953`](https://github.com/MadAppGang/claudish/commit/687b953da738bedf944c387e7bfe3e01857e946a))

## [3.6.1] - 2026-01-22

### Bug Fixes

- v3.6.1 - network error handling with SSE response format([`be37a5c`](https://github.com/MadAppGang/claudish/commit/be37a5cc226421eca7bdef69cfd7fede8c4849fb))
- handle network errors with proper SSE response format([`7f00208`](https://github.com/MadAppGang/claudish/commit/7f002084ee187a38cd043e7bd8cd1649460fae4e))

## [3.6.0] - 2026-01-22

### Documentation

- add OllamaCloud to packages/cli help text([`04c6aeb`](https://github.com/MadAppGang/claudish/commit/04c6aeb2612e0f4e938588be58b76f972fa69b88))
- add OllamaCloud provider documentation([`2bdb38a`](https://github.com/MadAppGang/claudish/commit/2bdb38a6421f0e889ee40f68d98f5f103c4dde79))

### New Features

- v3.6.0 - OllamaCloud provider support([`835ffdf`](https://github.com/MadAppGang/claudish/commit/835ffdf59f1830c636dd83078f3dc3101fd7154e))
- add OllamaCloud provider support with oc/ prefix([`4dba1a5`](https://github.com/MadAppGang/claudish/commit/4dba1a5bfc74f49b78c36f0b7b1c421bd7b7de30))
- add Claude Code Action for PR assistance([`f3d548d`](https://github.com/MadAppGang/claudish/commit/f3d548d334e6facba4cdf5c38fff99e4f53078db))
- add issue triage bot with Claude Code([`5d8b970`](https://github.com/MadAppGang/claudish/commit/5d8b9700c425b307313c8420e798182eb6e926f6))
- add Poe API provider support *(providers)* ([`57c5cb3`](https://github.com/MadAppGang/claudish/commit/57c5cb362a2abe64fb6a634bdccc0d86675d341c))

## [3.5.0] - 2026-01-21

### Bug Fixes

- use fixed default port 8899 for reliable communication *(proxy)* ([`ddd1c70`](https://github.com/MadAppGang/claudish/commit/ddd1c709e16e380b011c71600bc74c39df604c1e))

### New Features

- add Vertex AI OAuth mode and partner model support([`2a3605d`](https://github.com/MadAppGang/claudish/commit/2a3605d0bd5b703ebac575146e9adb374c5d7771))
- robust port communication with lock file and health checks *(proxy)* ([`f4b5faa`](https://github.com/MadAppGang/claudish/commit/f4b5faaee1ec66d74c97b2e98451cf818a4118b1))
- per-instance proxy via --proxy-server flag *(ClaudishProxy)* ([`2325d4d`](https://github.com/MadAppGang/claudish/commit/2325d4d15e64dec60f4437d4243cf86f7efa0ba6))
- add Vertex AI Express Mode support *(providers)* ([`c214a3c`](https://github.com/MadAppGang/claudish/commit/c214a3c6a00ef6def1e24e7edf8508616e48b547))
- native OpenAI routing, error display, and config sync *(proxy)* ([`515399e`](https://github.com/MadAppGang/claudish/commit/515399e67cc9aee76f852bb7888dca4fe1827dae))
- add auto-recovery and stale proxy cleanup *(ClaudishProxy)* ([`f2769ab`](https://github.com/MadAppGang/claudish/commit/f2769abfe65182ee777688cc71f12626dfb46ba0))
- add model routing and conversation sync persistence *(macos-bridge)* ([`ca645f3`](https://github.com/MadAppGang/claudish/commit/ca645f36a2418771dd1e733100f0f2c647f51499))

### Other Changes

- remove verbose status check debug log([`9cfc753`](https://github.com/MadAppGang/claudish/commit/9cfc753f0320d48bfc27aa7a62e512993008b617))

## [3.4.1] - 2026-01-20

### Documentation

- add MCP server documentation to --help and AI_AGENT_GUIDE([`91646f3`](https://github.com/MadAppGang/claudish/commit/91646f3936d7154424cadfa796f82ceb93ffab8a))

### New Features

- add zombie process hunting and recovery *(macos-bridge)* ([`087cf56`](https://github.com/MadAppGang/claudish/commit/087cf564667d604eff7a9a132238bfc889cfca52))
- SQLite stats, HTTPS interception, improved About screen *(ClaudishProxy)* ([`52e0626`](https://github.com/MadAppGang/claudish/commit/52e0626e6fd24887a16187a91fe0152e3306d282))
- add model profiles and dynamic model picker *(ClaudishProxy)* ([`6ce5cf6`](https://github.com/MadAppGang/claudish/commit/6ce5cf6c5c341fb851cf778ea7c239edb62f516f))
- add StatsPanel UI with activity table *(ClaudishProxy)* ([`9cc4fe1`](https://github.com/MadAppGang/claudish/commit/9cc4fe1e18395c65b431836bf23b9639a15b26fe))

## [3.4.0] - 2026-01-16

### New Features

- v3.4.0 - add claudish update command([`23a09e7`](https://github.com/MadAppGang/claudish/commit/23a09e76a34770f1e9d94b4898a6fb436313a337))
- add claudish update command([`504b52e`](https://github.com/MadAppGang/claudish/commit/504b52e21a6f4d80dd074c3c36dfc8975cc00d29))

## [3.3.12] - 2026-01-15

### Bug Fixes

- OpenAI Codex Responses API streaming and ID mapping([`b033084`](https://github.com/MadAppGang/claudish/commit/b033084d16a2c3ea85c603be6f2d2c22cc9bd730))
- proper cleanup and send() helper in Codex streaming([`d9cd2dd`](https://github.com/MadAppGang/claudish/commit/d9cd2dd9aef2e463ba51f7761977f25a470c36fc))

## [3.3.10] - 2026-01-15

### Bug Fixes

- add ping event after message_start for Responses API streaming([`6ee1da2`](https://github.com/MadAppGang/claudish/commit/6ee1da2b88454277dd3c149c37ee2d1915bc1425))

## [3.3.9] - 2026-01-15

### Bug Fixes

- calculate cost using incremental input tokens, not full context([`08aa13c`](https://github.com/MadAppGang/claudish/commit/08aa13ca70a7cd67ca30139573fe20bf0a0a6ad7))

## [3.3.8] - 2026-01-15

### Bug Fixes

- use placeholder input_tokens in message_start for Responses API([`a974c49`](https://github.com/MadAppGang/claudish/commit/a974c4906fb7b21fdf18ee269be7b63de0954341))

## [3.3.7] - 2026-01-15

### Bug Fixes

- handle both response.completed and response.done for token counting([`1a6b383`](https://github.com/MadAppGang/claudish/commit/1a6b383dbfb20836637b9474750f69624caf66b2))

## [3.3.6] - 2026-01-15

### Bug Fixes

- Responses API function_call as top-level items, not content blocks([`c9ed4ef`](https://github.com/MadAppGang/claudish/commit/c9ed4ef85c909a982d9eea0cf60e27f5f3b1ebf6))

## [3.3.5] - 2026-01-15

### Bug Fixes

- proper Responses API format for images and function calling([`b6d4af0`](https://github.com/MadAppGang/claudish/commit/b6d4af054aee29ec0bcb77aea0733f0639b1ea12))

## [3.3.4] - 2026-01-15

### Bug Fixes

- correct Responses API message format for Codex models([`8178f8e`](https://github.com/MadAppGang/claudish/commit/8178f8e3d349866ae1947b07cadd8100d4dfe86d))

## [3.3.3] - 2026-01-15

### New Features

- add OpenAI Codex model support via Responses API([`5b7d630`](https://github.com/MadAppGang/claudish/commit/5b7d63092f8dde7e0338fda2bcf591814341891c))

## [3.3.2] - 2026-01-15

### Bug Fixes

- build core before binary in CI([`1b3d93d`](https://github.com/MadAppGang/claudish/commit/1b3d93db959433c2595aa0e806211aff1b608417))

## [3.3.1] - 2026-01-15

### Bug Fixes

- build from root to preserve workspace resolution in CI([`4bcc332`](https://github.com/MadAppGang/claudish/commit/4bcc33260c267862a0d1768f297aa546ab266184))

## [3.3.0] - 2026-01-15

### Bug Fixes

- update CI/CD for monorepo structure([`97d2f68`](https://github.com/MadAppGang/claudish/commit/97d2f68c4bbf8e313d149dbfa8321b9cf9c1e444))

### New Features

- convert to monorepo with macOS desktop proxy support([`1962c38`](https://github.com/MadAppGang/claudish/commit/1962c387790de1ee7363809c17ace77899c3d72f))

## [3.2.3] - 2026-01-12

### Bug Fixes

- add thoughtSignature support for Gemini direct API([`42fa475`](https://github.com/MadAppGang/claudish/commit/42fa47534e9931652089df48328bb9b1e05dfeb1))

## [3.2.2] - 2026-01-12

### Bug Fixes

- use max_completion_tokens for newer OpenAI models([`b82f447`](https://github.com/MadAppGang/claudish/commit/b82f4472b513e289c221579a89386b679c83c4ef))

## [3.2.1] - 2026-01-11

### Bug Fixes

- sanitize JSON schema for Gemini API compatibility([`94318fb`](https://github.com/MadAppGang/claudish/commit/94318fbc173ad0fe1aac6185b02fd23c0993873e))

### Other Changes

- format codebase and update recommended models([`b350fb9`](https://github.com/MadAppGang/claudish/commit/b350fb9867a7156ced575011d63570cf9e746667))

## [3.2.0] - 2026-01-07

### New Features

- add direct API support for MiniMax, Kimi, and GLM providers([`129417b`](https://github.com/MadAppGang/claudish/commit/129417bc2e2b4278ee8c9456370cf13b505680fe))

## [3.1.3] - 2026-01-05

### Bug Fixes

- google/ prefix now routes to OpenRouter, not Gemini Direct([`9ccfa19`](https://github.com/MadAppGang/claudish/commit/9ccfa19461232fcffc4d465ff4bdc655a913f026))

## [3.1.2] - 2026-01-05

### Documentation

- update documentation for multi-provider routing([`1cab9d7`](https://github.com/MadAppGang/claudish/commit/1cab9d753d70a43ee729fe53af878050f44f62c6))

## [3.1.1] - 2026-01-05

### Bug Fixes

- enable tool support for MLX provider([`41203bd`](https://github.com/MadAppGang/claudish/commit/41203bdc77bedb40756edcff619d69be98a3a790))

## [3.1.0] - 2026-01-04

### New Features

- direct Gemini and OpenAI API support with prefix routing([`2b0064d`](https://github.com/MadAppGang/claudish/commit/2b0064d29e65ef3200716bc56d3a81998efaddeb))

## [3.0.6] - 2025-12-29

### Bug Fixes

- status line cost display always showing $0.000([`2f53e70`](https://github.com/MadAppGang/claudish/commit/2f53e70931371950bbb4e76ed043f095c808539a))

## [3.0.5] - 2025-12-29

### Bug Fixes

- token file path mismatch causing status line to show 100% context([`c2e396d`](https://github.com/MadAppGang/claudish/commit/c2e396d4e7d08216194a324387cd1fd6bf955fc9))

## [3.0.4] - 2025-12-29

### Bug Fixes

- expand Gemini reasoning filter patterns([`5a014c4`](https://github.com/MadAppGang/claudish/commit/5a014c40505d91c8a9edb6d41d16ca9f2f98ef41))

## [3.0.3] - 2025-12-27

### Bug Fixes

- Gemini reasoning leakage and native thinking block support([`523c0e4`](https://github.com/MadAppGang/claudish/commit/523c0e40cd5949aa09a1bd2b300bc87cc9bf4cf1))

## [3.0.2] - 2025-12-26

### Bug Fixes

- OpenRouter token tracking and debug logging([`f4c1df2`](https://github.com/MadAppGang/claudish/commit/f4c1df2c24f8d5255c77481339481a8fabd35746))

## [3.0.1] - 2025-12-23

### Bug Fixes

- update HTTP-Referer to claudish.com for OpenRouter visibility([`dae66c4`](https://github.com/MadAppGang/claudish/commit/dae66c44e8d892113f0ec46b4bc0af7f661603d9))
- move settings files to ~/.claudish to avoid socket watch errors([`20271eb`](https://github.com/MadAppGang/claudish/commit/20271ebb25dd85515d9cf9b8b2e93ac22ec6037b))

### Other Changes

- add CLAUDE.md and update .gitignore([`30c65d1`](https://github.com/MadAppGang/claudish/commit/30c65d1b21dda587ac7e9941a58d276a5790960a))

## [3.0.0] - 2025-12-14

### New Features

- v3.0.0 - Full local model support (Ollama, LM Studio)([`a216c95`](https://github.com/MadAppGang/claudish/commit/a216c9556f2c0b9e20ee68e45ac1579275a72604))

## [2.11.0] - 2025-12-13

### New Features

- Add tool summarization and improved local model support([`3139af9`](https://github.com/MadAppGang/claudish/commit/3139af919b958e0aefa23245c772db5ba80e1fca))

## [2.10.1] - 2025-12-13

### Bug Fixes

- Windows spawn ENOENT - runtime platform detection([`51de48f`](https://github.com/MadAppGang/claudish/commit/51de48f1b464e5cceceb05aee5d07a1f56a2b44c))

## [2.10.0] - 2025-12-13

### New Features

- Improve local model UX - tool support detection, context tracking([`d71a9ca`](https://github.com/MadAppGang/claudish/commit/d71a9ca9139bd03aa7d45ed53a770c5605b7b521))

## [2.9.0] - 2025-12-13

### Documentation

- Update installation section with all distribution options([`a43949b`](https://github.com/MadAppGang/claudish/commit/a43949b648abda9a704af8e84dd6a604f19aac78))

### New Features

- Add local Ollama models support([`d92933e`](https://github.com/MadAppGang/claudish/commit/d92933e0377d15d141c27226cc1c38f154db5392))

## [2.8.1] - 2025-12-12

### Bug Fixes

- Use build:ci for npm publish (skip extract-models)([`e60ad5b`](https://github.com/MadAppGang/claudish/commit/e60ad5b0764628b177d1bc5071104e708883bef4))

## [2.8.0] - 2025-12-12

### Bug Fixes

- CI workflow - use macos-15-intel, skip extract-models([`07db17e`](https://github.com/MadAppGang/claudish/commit/07db17e99e6e520f3a1580ecc225c057772b2204))
- fix some view of langing page([`8b9004d`](https://github.com/MadAppGang/claudish/commit/8b9004d0dd9f873b6c9796a0f7113066ba48fde6))

### New Features

- Add automated release pipeline([`31492fc`](https://github.com/MadAppGang/claudish/commit/31492fcba0d8c1dcdf0c7c745244c42b10cbabfa))
- Add profile-based model configuration v2.8.0 *(profiles)* ([`a3303a1`](https://github.com/MadAppGang/claudish/commit/a3303a12dbb54b9e5c0d2eb0ff27b19814fd43c1))


