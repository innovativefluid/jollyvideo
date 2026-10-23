/** An error whose message is meant for the person who caused it. */
export class UserError extends Error {
  override name = "UserError";
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** what a user gets to read about an error; anything unexpected stays in the log */
export const userText = (error: unknown): string => (error instanceof UserError ? error.message : "Something went wrong");
