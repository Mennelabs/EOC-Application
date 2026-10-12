/** Playwright global setup: wait until the worker has provisioned the cast accounts. */
import { waitForProvisioning } from '../support/stack.ts';

export default async function globalSetup(): Promise<void> {
  await waitForProvisioning();
}
