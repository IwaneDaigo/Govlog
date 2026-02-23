export type Municipality = {
  code: string;
  name: string;
};

export type MunicipalityOption = {
  code: string;
  name: string;
  prefecture: string;
  displayName: string;
};

export type TwinCity = {
  municipalityCode: string;
  municipalityName: string;
  score: number;
};

export type Policy = {
  id: string;
  municipalityCode: string;
  municipalityName: string;
  title: string;
  summary?: string;
  details?: string;
  keywords?: string[];
  pdfPath?: string;
  pdfUrl?: string;
};

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const hasBody = init?.body !== undefined && init?.body !== null;

  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(init?.headers ?? {})
    }
  });

  if (!response.ok) {
    let message = "Request failed";
    try {
      const payload = (await response.json()) as { message?: string };
      if (payload.message) {
        message = payload.message;
      }
    } catch {
      // Keep generic message when response is not JSON.
    }
    throw new Error(message);
  }

  return response.json() as Promise<T>;
}

export const api = {
  login: (municipalityCode: string) =>
    request<{ municipality: Municipality }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ municipalityCode })
    }),
  logout: () =>
    request<{ success: boolean }>("/api/auth/logout", {
      method: "POST"
    }),
  me: () => request<{ municipality: Municipality }>("/api/me"),
  municipalities: (query: string, limit = 20) =>
    request<{ municipalities: MunicipalityOption[] }>(
      `/api/municipalities?query=${encodeURIComponent(query)}&limit=${limit}`
    ),
  search: (keyword: string) =>
    request<{ top5Cities: TwinCity[]; similarCities?: TwinCity[]; worstCities?: TwinCity[]; policies: Policy[] }>(
      `/api/search?keyword=${encodeURIComponent(keyword)}`
    ),
  policy: (policyId: string) => request<{ policy: Policy }>(`/api/policies/${policyId}`)
};
