/**
 * Модуль retry логики для транзакций
 */

export type RetryOptions = {
  maxRetries?: number;
  retryDelayMs?: number;
  exponentialBackoff?: boolean;
  onRetry?: (attempt: number, error: Error) => void;
};

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  retryDelayMs: 1000,
  exponentialBackoff: true,
  onRetry: (attempt, error) => {
    console.log(`Retry attempt ${attempt} after error: ${error.message}`);
  },
};

/**
 * Выполнить функцию с retry логикой
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      
      // Если это последняя попытка, выбрасываем ошибку
      if (attempt === opts.maxRetries) {
        throw error;
      }

      // Вызываем callback если есть
      if (opts.onRetry) {
        opts.onRetry(attempt + 1, lastError);
      }

      // Рассчитываем задержку
      const delay = opts.exponentialBackoff
        ? opts.retryDelayMs * Math.pow(2, attempt)
        : opts.retryDelayMs;

      // Ждем перед следующей попыткой
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError || new Error('Retry failed');
}

/**
 * Выполнить транзакцию с retry
 */
export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  return withRetry(fn, {
    ...options,
    onRetry: (attempt, error) => {
      console.log(`Transaction retry attempt ${attempt}/${options.maxRetries || 3}: ${error.message}`);
      if (options.onRetry) {
        options.onRetry(attempt, error);
      }
    },
  });
}

