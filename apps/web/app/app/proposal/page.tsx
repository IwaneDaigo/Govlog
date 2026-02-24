"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import {
    Badge,
    Box,
    Button,
    FormControl,
    FormLabel,
    Heading,
    HStack,
    Input,
    Link,
    Stack,
    Text,
    Textarea
} from "@chakra-ui/react";
import { api, Municipality, ProposalDraft, ProposalReviewResponse, ProposalSimilarItem } from "../../../lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

type SectionField = {
    key: string;
    label: string;
    placeholder: string;
};

const SECTION_FIELDS: SectionField[] = [
    { key: "background", label: "背景", placeholder: "現状・課題を簡潔に記載" },
    { key: "objective", label: "目的", placeholder: "この企画で達成したいこと" },
    { key: "scope", label: "対象・範囲", placeholder: "対象者、対象地域、対象業務など" },
    { key: "approach", label: "施策内容", placeholder: "具体的な取り組み内容" },
    { key: "schedule", label: "期間", placeholder: "開始〜完了までの計画" },
    { key: "budget", label: "予算", placeholder: "概算や内訳の要点" },
    { key: "effects", label: "KPI", placeholder: "定量・定性の指標" },
    { key: "risks", label: "リスク", placeholder: "想定リスクと対応" },
    { key: "notes", label: "根拠", placeholder: "根拠・参考情報" }
];

export default function ProposalPage() {
    const router = useRouter();
    const [municipality, setMunicipality] = useState<Municipality | null>(null);
    const [title, setTitle] = useState("");
    const [fields, setFields] = useState<Record<string, string>>({});
    const [submitting, setSubmitting] = useState(false);
    const [findingSimilar, setFindingSimilar] = useState(false);
    const [similarItems, setSimilarItems] = useState<ProposalSimilarItem[]>([]);
    const [reviewing, setReviewing] = useState(false);
    const [reviewResult, setReviewResult] = useState<ProposalReviewResponse | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [pdfUrl, setPdfUrl] = useState<string | null>(null);

    useEffect(() => {
        api.me()
            .then((res) => setMunicipality(res.municipality))
            .catch(() => router.push("/login"));
    }, [router]);

    useEffect(() => {
        if (!municipality) return;
    }, [municipality, title]);

    useEffect(() => {
        return () => {
            if (pdfUrl) URL.revokeObjectURL(pdfUrl);
        };
    }, [pdfUrl]);

    const sections = useMemo(
        () =>
            SECTION_FIELDS.map((field) => ({
                label: field.label,
                value: fields[field.key] ?? ""
            })),
        [fields]
    );

    const proposalDraft: ProposalDraft = {
        title: title.trim(),
        purpose: fields.objective?.trim() ?? "",
        target: fields.scope?.trim() ?? "",
        content: fields.approach?.trim() ?? "",
        kpi: fields.effects?.trim() ?? "",
        budget: fields.budget?.trim() ?? "",
        period: fields.schedule?.trim() ?? "",
        evidence: fields.notes?.trim() ?? ""
    };

    const validateDraft = (): string | null => {
        const requiredFields: Array<keyof ProposalDraft> = [
            "title",
            "purpose",
            "target",
            "content",
            "kpi",
            "budget",
            "period",
            "evidence"
        ];
        const missing = requiredFields.filter((key) => !proposalDraft[key] || proposalDraft[key].trim().length === 0);
        if (missing.length === 0) return null;
        return "必須項目が未入力です。";
    };

    const onFindSimilar = async () => {
        const validationError = validateDraft();
        if (validationError) {
            setError(validationError);
            return;
        }
        setFindingSimilar(true);
        setError(null);
        setMessage(null);
        try {
            const res = await api.proposalSimilar({ proposalDraft, topK: 5 });
            setSimilarItems(res.similarItems);
            setReviewResult(null);
            if (res.notice) {
                setMessage(res.notice);
            } else if (res.similarItems.length === 0) {
                setMessage("類似施策が見つかりませんでした。入力内容を増やして再実行してください。");
            } else {
                setMessage("類似施策を取得しました。");
            }
        } catch (e) {
            setError(e instanceof Error ? e.message : "類似施策の取得に失敗しました。");
        } finally {
            setFindingSimilar(false);
        }
    };

    const onReview = async () => {
        const validationError = validateDraft();
        if (validationError) {
            setError(validationError);
            return;
        }
        if (similarItems.length === 0) {
            setError("先に類似施策を取得してください。");
            return;
        }
        setReviewing(true);
        setError(null);
        setMessage(null);
        try {
            const res = await api.proposalReview({
                proposalDraft,
                similarItems: similarItems.map((item) => ({
                    id: item.id,
                    evidenceText: [
                        `タイトル: ${item.title}`,
                        `自治体: ${item.municipality}`,
                        `概要: ${item.summary ?? ""}`,
                        `根拠抜粋: ${item.evidenceSnippets[0] ?? ""}`
                    ].join("\n")
                })),
                style: "strict",
                length: "long"
            });
            setReviewResult(res);
        } catch (e) {
            setError(e instanceof Error ? e.message : "添削/アドバイスの生成に失敗しました。");
        } finally {
            setReviewing(false);
        }
    };

    const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setSubmitting(true);
        setError(null);
        setMessage(null);
        if (pdfUrl) {
            URL.revokeObjectURL(pdfUrl);
            setPdfUrl(null);
        }

        try {
            const response = await fetch(`${API_BASE}/api/proposals/pdf`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    title: title.trim(),
                    sections
                })
            });
            if (!response.ok) {
                const payload = await response.json().catch(() => null);
                throw new Error(payload?.message ?? "PDFの生成に失敗しました。");
            }
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            setPdfUrl(url);
            setMessage("PDFを生成しました。下のボタンから開いて確認してください。");
        } catch (e) {
            setError(e instanceof Error ? e.message : "PDFの生成に失敗しました。");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Stack spacing={6}>
            <HStack justify="space-between" align="start">
                <Box>
                    <Heading size="lg">企画書の作成</Heading>
                    <Text mt={1} color="gray.600" fontSize="sm">
                        {municipality ? `${municipality.name} (${municipality.code})` : "ログイン情報を確認中..."}
                    </Text>
                </Box>
                <Link as={NextLink} href="/app/search" fontSize="sm" fontWeight="semibold" color="orange.500">
                    戻る
                </Link>
            </HStack>

            <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
                <form onSubmit={onSubmit}>
                    <Stack spacing={4}>
                        <FormControl isRequired>
                            <FormLabel>企画タイトル</FormLabel>
                            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例：地域DX推進企画" />
                        </FormControl>

                        {SECTION_FIELDS.map((field) => (
                            <FormControl key={field.key} isRequired={["objective", "scope", "approach", "schedule", "budget", "effects", "notes"].includes(field.key)}>
                                <FormLabel>{field.label}</FormLabel>
                                <Textarea
                                    value={fields[field.key] ?? ""}
                                    onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                                    placeholder={field.placeholder}
                                    rows={3}
                                />
                            </FormControl>
                        ))}

                        <HStack spacing={3}>
                            <Button type="button" variant="outline" onClick={onFindSimilar} isLoading={findingSimilar}>
                                類似施策を探す
                            </Button>
                            <Button type="button" variant="outline" onClick={onReview} isLoading={reviewing}>
                                添削/アドバイス生成
                            </Button>
                            <Button type="submit" colorScheme="blue" isLoading={submitting}>
                                PDFを作成
                            </Button>
                        </HStack>
                        {message ? (
                            <Box rounded="xl" bg="green.50" borderWidth="1px" borderColor="green.200" p={4}>
                                <Text fontSize="sm" color="green.700">
                                    {message}
                                </Text>
                            </Box>
                        ) : null}
                        {error ? (
                            <Box rounded="xl" bg="red.50" borderWidth="1px" borderColor="red.200" p={4}>
                                <Text fontSize="sm" color="red.700">
                                    {error}
                                </Text>
                            </Box>
                        ) : null}
                    </Stack>
                </form>
            </Box>

            {similarItems.length > 0 ? (
                <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
                    <Heading size="sm">類似施策（Top{similarItems.length}）</Heading>
                    <Stack mt={4} spacing={3}>
                        {similarItems.map((item) => (
                            <Box key={item.id} rounded="lg" borderWidth="1px" p={4} bg="gray.50">
                                <HStack justify="space-between">
                                    <Text fontWeight="semibold">{item.title}</Text>
                                    <Badge colorScheme="orange">{(item.score * 100).toFixed(1)}点</Badge>
                                </HStack>
                                <Text mt={1} fontSize="sm" color="gray.600">
                                    {item.municipality} {item.year ? `(${item.year})` : ""}
                                </Text>
                                <Text mt={2} fontSize="sm">{item.summary || item.evidenceSnippets[0]}</Text>
                                <Link as={NextLink} href={`/app/policies/${item.id}`} fontSize="sm" color="orange.500" mt={2} display="inline-block">
                                    施策詳細を見る
                                </Link>
                            </Box>
                        ))}
                    </Stack>
                </Box>
            ) : null}

            {reviewResult ? (
                <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
                    <Heading size="sm">添削/アドバイス結果</Heading>
                    <Stack mt={4} spacing={4}>
                        <Box>
                            <Heading size="xs" mb={2}>修正版</Heading>
                            <Text fontSize="sm">{reviewResult.revised_proposal.title}</Text>
                        </Box>
                        <Box>
                            <Heading size="xs" mb={2}>総評</Heading>
                            <Box
                                rounded="lg"
                                borderWidth="1px"
                                borderColor="blue.100"
                                bg="blue.50"
                                p={4}
                            >
                                <Stack spacing={2}>
                                    {reviewResult.overall_review
                                        .split(/(?<=[。！？])/)
                                        .map((line) => line.trim())
                                        .filter((line) => line.length > 0)
                                        .map((line, idx) => (
                                            <Text key={`overall-${idx}`} fontSize="sm" lineHeight="1.9">
                                                {line}
                                            </Text>
                                        ))}
                                </Stack>
                            </Box>
                        </Box>
                        <Box>
                            <Heading size="xs" mb={2}>類似施策との比較評価</Heading>
                            <Stack spacing={3} fontSize="sm">
                                <Box>
                                    <Text fontWeight="semibold">合う点</Text>
                                    <Text lineHeight="1.8">{reviewResult.fit_analysis.matching_points.join(" / ") || "該当なし"}</Text>
                                </Box>
                                <Box>
                                    <Text fontWeight="semibold">合わない点</Text>
                                    <Text lineHeight="1.8">{reviewResult.fit_analysis.non_matching_points.join(" / ") || "該当なし"}</Text>
                                </Box>
                                <Box>
                                    <Text fontWeight="semibold">強い点</Text>
                                    <Text lineHeight="1.8">{reviewResult.fit_analysis.good_points.join(" / ") || "該当なし"}</Text>
                                </Box>
                                <Box>
                                    <Text fontWeight="semibold">弱い点</Text>
                                    <Text lineHeight="1.8">{reviewResult.fit_analysis.weak_points.join(" / ") || "該当なし"}</Text>
                                </Box>
                            </Stack>
                        </Box>
                        <Box>
                            <Heading size="xs" mb={2}>改善アクション</Heading>
                            <Text fontSize="sm" lineHeight="1.8">{reviewResult.improvement_actions.join(" / ") || "該当なし"}</Text>
                        </Box>
                        <Box>
                            <Heading size="xs" mb={2}>引用</Heading>
                            <Stack spacing={2}>
                                {reviewResult.citations.map((item, idx) => (
                                    <Box key={`${item.source_id}-${idx}`} borderWidth="1px" rounded="md" p={3}>
                                        <Text fontSize="sm">{item.municipality} {item.year ? `(${item.year})` : ""}</Text>
                                        <Text fontSize="sm" color="gray.600">{item.quote}</Text>
                                        <Text fontSize="xs" color="gray.500">used_for: {item.used_for}</Text>
                                    </Box>
                                ))}
                            </Stack>
                        </Box>
                    </Stack>
                </Box>
            ) : null}

            {pdfUrl ? (
                <HStack>
                    <Button as="a" href={pdfUrl} target="_blank" rel="noopener noreferrer" colorScheme="green">
                        PDFを開く
                    </Button>
                    <Button as="a" href={pdfUrl} download="proposal.pdf" variant="outline">
                        ダウンロード
                    </Button>
                </HStack>
            ) : null}

        </Stack>
    );
}
