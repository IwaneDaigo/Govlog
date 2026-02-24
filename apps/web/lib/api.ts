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
  axisScore?: { need: number; support: number; feasibility: number };
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

export type ImportPdfRequest = {
  inputPdfPath: string;
  idPrefix: string;
  outDir?: string;
  policiesOutPath?: string;
  municipalityCode?: string;
  municipalityName?: string;
  mergeToPoliciesJson?: boolean;
};

export type ImportPdfUploadPayload = {
  idPrefix: string;
  outDir?: string;
  policiesOutPath?: string;
  municipalityCode?: string;
  municipalityName?: string;
  mergeToPoliciesJson?: boolean;
};

export type ImportPdfPreviewItem = {
  id: string;
  title: string;
  startPage: number;
  endPage: number;
  pageCount: number;
};

export type ProposalDraft = {
    title: string;
    purpose: string;
    target: string;
    content: string;
    kpi: string;
    budget: string;
    period: string;
    evidence: string;
};

export type ProposalSimilarItem = {
    id: string;
    score: number;
    municipality: string;
    year: number | null;
    title: string;
    summary: string;
    evidenceSnippets: string[];
};

export type ProposalReviewItem = {
    id: string;
    evidenceText: string;
};

export type ProposalReviewResponse = {
    revised_proposal: ProposalDraft;
    diff: Array<{ field: keyof ProposalDraft; before: string; after: string }>;
    overall_review: string;
    fit_analysis: {
        good_points: string[];
        weak_points: string[];
        matching_points: string[];
        non_matching_points: string[];
    };
    improvement_actions: string[];
    advice?: {
        kpi_suggestions: string[];
        risks: string[];
        implementation_steps: string[];
        budget_notes: string[];
        evaluation_plan: string[];
    };
    citations: Array<{
        source_id: string;
        municipality: string;
        year: number | null;
        quote: string;
        used_for: string;
    }>;
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
      const payload = (await response.json()) as { message?: string; error?: { message?: string } };
      if (payload?.error?.message) {
        message = payload.error.message;
      } else if (payload?.message) {
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
  importPdf: (payload: ImportPdfRequest) =>
    request<{
      success: boolean;
      result: {
        pageCount: number;
        segmentCount: number;
        outDir: string;
        policiesOutPath: string;
        mergedPoliciesPath?: string;
        mergedAdded?: number;
      };
    }>("/api/admin/import-pdf", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  importPdfUploadPreview: async (file: File, payload: ImportPdfUploadPayload) => {
    const form = new FormData();
    form.append("pdf", file);
    form.append("idPrefix", payload.idPrefix);
    if (payload.outDir) form.append("outDir", payload.outDir);
    if (payload.policiesOutPath) form.append("policiesOutPath", payload.policiesOutPath);
    if (payload.municipalityCode) form.append("municipalityCode", payload.municipalityCode);
    if (payload.municipalityName) form.append("municipalityName", payload.municipalityName);
    if (payload.mergeToPoliciesJson !== undefined) {
      form.append("mergeToPoliciesJson", String(payload.mergeToPoliciesJson));
    }

    const response = await fetch(`${API_BASE}/api/admin/import-pdf/upload/preview`, {
      method: "POST",
      credentials: "include",
      body: form
    });
    if (!response.ok) {
      let message = "Request failed";
      try {
        const payloadJson = (await response.json()) as { message?: string; error?: { message?: string } };
        if (payloadJson?.error?.message) {
          message = payloadJson.error.message;
        } else if (payloadJson?.message) {
          message = payloadJson.message;
        }
      } catch {
        // Keep generic message.
      }
      throw new Error(message);
    }

    return (await response.json()) as {
      success: boolean;
      token: string;
      preview: {
        pageCount: number;
        segmentCount: number;
        outDir: string;
        policiesOutPath: string;
        previewItems: ImportPdfPreviewItem[];
        mlPredictionUsed: boolean;
      };
    };
  },
  confirmImportPdfUpload: (token: string, selectedIds?: string[]) =>
    request<{
      success: boolean;
      result: {
        pageCount: number;
        segmentCount: number;
        outDir: string;
        policiesOutPath: string;
        mergedPoliciesPath?: string;
        mergedAdded?: number;
        mlPredictionUsed: boolean;
      };
    }>("/api/admin/import-pdf/upload/confirm", {
      method: "POST",
      body: JSON.stringify({ token, selectedIds })
    }),
  deletePolicies: (policyIds: string[]) =>
    request<{ success: boolean; deletedCount: number }>("/api/admin/policies/delete", {
      method: "POST",
      body: JSON.stringify({ policyIds })
    }),
  proposalSimilar: (payload: { proposalDraft: ProposalDraft; municipalityCode?: string; yearRange?: [number, number]; topK?: number }) =>
    request<{ similarItems: ProposalSimilarItem[]; notice?: string | null }>("/api/proposals/similar", {
      method: "POST",
      body: JSON.stringify(payload)
    }),
  proposalReview: (payload: { proposalDraft: ProposalDraft; similarItems: ProposalReviewItem[]; style?: "strict" | "gentle"; length?: "short" | "medium" | "long" }) =>
    request<ProposalReviewResponse>("/api/proposals/review", {
        method: "POST",
        body: JSON.stringify(payload)
    }),
  policy: (policyId: string) => request<{ policy: Policy }>(`/api/policies/${policyId}`)
};
