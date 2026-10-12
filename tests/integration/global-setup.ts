/** Vitest global setup for the integration project: wait until the worker has provisioned the cast. */
import { waitForProvisioning } from '../support/stack.ts';

export default async function setup(): Promise<void> {
  await waitForProvisioning();
}
