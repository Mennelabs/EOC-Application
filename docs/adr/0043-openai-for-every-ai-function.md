# ADR-0043: OpenAI behind the AI interfaces for every function; a damage classifier interface; no fake provider in running systems

- Status: accepted (Adam's answers of 2026-10-15, `docs/decisions.md`)
- Date: 2026-10-15
- Requirements: AIG-01–AIG-12, AI-01–AI-12, PHO-07, PHO-09–PHO-15, FL-04, FL-14, FL-18, INT-12, PUB-14, REC-13, SCL-06, GATE-08, BRD:INT-04

## Decision

- **OpenAI is the provider for every AI function** until a cloud provider is chosen with the first customer. It fills the four interfaces of ADR-0025 (language model, speech-to-text, translation, image analysis), and also text-to-speech and web search.
- **A fifth interface, the damage classifier (PHO-12), is added.** OpenAI's vision model fills it for now. A model registry records the model and prompt version behind each suggestion, so a validated classifier can replace it through configuration.
- **Model names are configuration per feature, not code.**
- **The key is the secret `OPENAI_API_KEY`.**
- **Running systems never use the fake provider.** Without a key the AI features are off and the manual paths run. The fake stays only as a test double in automated tests and in the free CI evaluation run. The same evaluation cases also run against OpenAI on demand, and a regression there blocks enabling the changed model or prompt (AIG-08).
- **What runs on OpenAI's side:**
  - Calls use the Responses API with a strict JSON schema for every structured output (AIG-03).
  - Untrusted content goes only in delimited data fields (AIG-02).
  - Outputs are validated on the server before anyone sees them.
  - Every call records feature, provider, model, template version, latency and outcome, never the prompt (AIG-01).
- **Two deviations from the requirement text, decided by Adam:**
  - The severity suggestion comes from a general vision model (PHO-12 asks for a purpose-trained one). It is labelled "AI suggestion — not verified", never shown to residents, never sets the degree, and its agreement with reviewers is published per group (PHO-13).
  - A crossed health threshold alerts the tenant administrator instead of switching the feature off (AIG-09). A provider failure or timeout still falls back to the non-AI path at once (AI-10).

## Alternatives considered

| Option                                                                           | Why not                                                                                                         |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| A government-cloud model service now (Azure OpenAI Government, Bedrock GovCloud) | Adam has no cloud account yet. The interfaces keep this a configuration change for the first customer.          |
| Keep the fake provider in running systems until a cloud provider exists          | Adam decided against it: no fake AI in anything people use.                                                     |
| A self-hosted open-weights model                                                 | Laptop-sized models fall short on the Spanish and vision tasks. It would also add a GPU to `docker compose up`. |
| Wait for the purpose-trained damage classifier                                   | The university partnership does not exist yet. Adam wants the suggestion now, with a person always deciding.    |

## Why it fits SCL-11 and the government-cloud move

- The provider is reached over HTTPS through the outbound allowlist (ADR-0042) and needs no container of its own, so `docker compose up` is unchanged.
- Moving to a FedRAMP-authorized model service means adding a provider entry with its compliance evidence, passing the evaluation suite for the tenant's languages, and changing the tenant's configuration. No caller changes.

## Consequences

- Every AI feature needs `OPENAI_API_KEY` in the environment where it runs. Without it the features say so and stay off.
- Usage is recorded per tenant, with no spending cap.
- The AIG-06 record for OpenAI carries Adam's statement that the Mennelabs organization has zero data retention, with the agreement attached.
- The register and the console show the two deviations above.
- ADR-0017 (proposed) is superseded by ADR-0025 and this record.
