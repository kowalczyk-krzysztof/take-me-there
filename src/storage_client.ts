// Page-side client for the worker storage service. Every shared-state
// mutation travels as a validated command; the worker executes. Transport
// failures and timeouts throw; command rejections throw StorageCommandError
// from sendCommand, or surface as a result from sendCommandResult for
// callers that must render verified state alongside the error.
import { STORAGE_MESSAGE_SCOPE, type CommandResult, type StorageCommand } from './storage_commands';

const COMMAND_TIMEOUT_MS = 30000;

export class StorageCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StorageCommandError';
  }
}

const isResult = (value: unknown): value is CommandResult => {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const result = value as Partial<CommandResult>;

  if (result.ok === true) {
    return true;
  }

  return result.ok === false && typeof result.error === 'string';
};

export const sendCommandResult = async (command: StorageCommand): Promise<CommandResult> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new StorageCommandError('storage command timed out')),
        COMMAND_TIMEOUT_MS
      );
    });

    const response = await Promise.race([
      chrome.runtime.sendMessage({ scope: STORAGE_MESSAGE_SCOPE, command }),
      timeout,
    ]);

    if (!isResult(response)) {
      throw new StorageCommandError('bad storage response');
    }

    return response;
  } finally {
    clearTimeout(timer);
  }
};

export const sendCommand = async <T>(command: StorageCommand): Promise<T> => {
  const result = await sendCommandResult(command);

  if (!result.ok) {
    throw new StorageCommandError(result.error);
  }

  return result.value as T;
};
