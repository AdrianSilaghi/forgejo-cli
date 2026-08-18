import { CliError } from "./errors.js";

export type DestructiveConfirmation = Readonly<{
  repository: string;
  resource: string;
  id: number | string;
  yes: boolean;
  confirm: string | undefined;
}>;

const SAFE_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SAFE_RESOURCE = /^[a-z][a-z0-9-]*$/;

export function confirmationFor(repository: string, resource: string, id: number | string): string {
  if (
    !SAFE_REPOSITORY.test(repository) ||
    !SAFE_RESOURCE.test(resource) ||
    String(id).length === 0
  ) {
    throw new CliError("validation_failed", "Cannot derive confirmation from an invalid target.");
  }

  return `${repository}#${resource}:${String(id)}`;
}

export function assertDestructiveConfirmation(input: DestructiveConfirmation): void {
  const expected = confirmationFor(input.repository, input.resource, input.id);
  if (!input.yes || input.confirm !== expected) {
    throw new CliError(
      "confirmation_required",
      `Destructive operation requires --yes --confirm ${expected}.`,
      { details: { expected_confirmation: expected } },
    );
  }
}
