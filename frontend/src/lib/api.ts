export class ApiError extends Error {
  constructor(message: string, public code?: string, public activeClients?: number) {
    super(message);
  }
}

export async function apiRequest<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Transfarr-Request": "1",
      ...options.headers,
    },
  });
  const result = await response.json();
  if (!response.ok) throw new ApiError(result.error || "Request failed", result.code, result.activeClients);
  return result as T;
}
