"use client";

import { ChangeEvent, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import {
    Box,
    Button,
    FormControl,
    FormHelperText,
    FormLabel,
    Heading,
    HStack,
    Input,
    Link,
    Spinner,
    Stack,
    Text
} from "@chakra-ui/react";
import { api, Municipality, ProposalCsvReviewRow } from "../../../lib/api";

const PROPOSAL_DEMO_MODE = (process.env.NEXT_PUBLIC_PROPOSAL_DEMO_MODE ?? "true").toLowerCase() !== "false";
const DEMO_LOADING_MS = 3000;

const DEMO_ADVICE = {
    overall: [
        "とてもよく考えられた企画です。",
        "「待機児童を減らす」だけでなく、妊娠期から就学前まで寄り添う支援を入れている点は特に良いです。",
        "量（保育定員）と質（伴走支援）の両方に取り組もうとしている点は、高評価です。",
        "ただし、さらに良くできるポイントもあります。"
    ],
    goodPoints: [
        "① 数値目標が明確: 「定員250人増」「待機児童ゼロ」など、成果がわかりやすい。",
        "② 伴走型支援の考え方が現代的: 単なる保育拡充ではなく、子どもの成長全体を見る姿勢がある。"
    ],
    improvePoints: [
        "① 小学校とのつながりが弱い: 幼保小連携会議、公開授業、共同研修などの制度化が有効。",
        "② 地域との連携が弱い: 地域ボランティア、休日学習支援、公民館活用を組み込むと厚みが出る。",
        "③ 指標が量寄り: 保護者の安心感や子育て孤立の減少など、質のアウトカム指標を増やす。"
    ],
    proposals: [
        "提案① 幼保小連携モデルを追加（連絡会、架け橋カリキュラム、合同研修）。",
        "提案② 放課後・休日学習支援を組み込む（地域・大学生・公民館活用）。",
        "提案③ 成果指標を更新（保護者復職率、子育て満足度、小1不安軽減率、第2子出生率）。"
    ],
    final: [
        "方向性はとても良いです。特に伴走支援を入れているのは大きな強みです。",
        "教育との接続、地域との連携、成果指標の質的高度化を入れれば、ワンランク上の政策になります。"
    ]
};

export default function ProposalPage() {
    const router = useRouter();
    const [municipality, setMunicipality] = useState<Municipality | null>(null);
    const [csvFile, setCsvFile] = useState<File | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<string | null>(null);
    const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
    const [downloadName, setDownloadName] = useState("proposal-review.csv");
    const [reviewRows, setReviewRows] = useState<ProposalCsvReviewRow[]>([]);
    const [showDemoAdvice, setShowDemoAdvice] = useState(false);
    const [fakeLoading, setFakeLoading] = useState(false);

    useEffect(() => {
        api.me()
            .then((res) => setMunicipality(res.municipality))
            .catch(() => router.push("/login"));
    }, [router]);

    useEffect(() => {
        return () => {
            if (downloadUrl) {
                URL.revokeObjectURL(downloadUrl);
            }
        };
    }, [downloadUrl]);

    const selectedFileLabel = useMemo(
        () => (csvFile ? `${csvFile.name} (${Math.ceil(csvFile.size / 1024)} KB)` : "未選択"),
        [csvFile]
    );

    const summaryRows = useMemo(() => reviewRows.filter((row) => row.section === "総評"), [reviewRows]);

    const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0] ?? null;
        setCsvFile(file);
        setError(null);
        setMessage(null);
        setReviewRows([]);
        setShowDemoAdvice(false);
        setFakeLoading(false);
        if (downloadUrl) {
            URL.revokeObjectURL(downloadUrl);
            setDownloadUrl(null);
        }
    };

    const onSubmit = async () => {
        if (!csvFile) {
            setError("CSVファイルを選択してください。");
            return;
        }
        if (!csvFile.name.toLowerCase().endsWith(".csv")) {
            setError("CSVファイルのみアップロードできます。");
            return;
        }

        setSubmitting(true);
        setError(null);
        setMessage(null);
        setShowDemoAdvice(false);

        if (PROPOSAL_DEMO_MODE) {
            setFakeLoading(true);
            setReviewRows([]);
            if (downloadUrl) {
                URL.revokeObjectURL(downloadUrl);
                setDownloadUrl(null);
            }
            try {
                await new Promise((resolve) => setTimeout(resolve, DEMO_LOADING_MS));
                setShowDemoAdvice(true);
               
            } finally {
                setFakeLoading(false);
                setSubmitting(false);
            }
            return;
        }

        try {
            const result = await api.proposalReviewCsv(csvFile);
            if (downloadUrl) {
                URL.revokeObjectURL(downloadUrl);
            }
            const blob = new Blob([result.csvContent], { type: "text/csv;charset=utf-8" });
            const url = URL.createObjectURL(blob);
            setDownloadUrl(url);
            setDownloadName(result.filename || "proposal-review.csv");
            setReviewRows(result.rows ?? []);
            setMessage(`添削結果を生成しました（${result.rows?.length ?? 0}件）。`);
        } catch (e) {
            setError(e instanceof Error ? e.message : "CSV添削の処理に失敗しました。");
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <Stack spacing={6}>
            <HStack justify="space-between" align="start">
                <Box>
                    <Heading size="lg">企画書CSV添削・アドバイス</Heading>
                    <Text mt={1} color="gray.600" fontSize="sm">
                        {municipality ? `${municipality.name} (${municipality.code})` : "ログイン情報を確認中..."}
                    </Text>
                </Box>
                <Link as={NextLink} href="/app/search" fontSize="sm" fontWeight="semibold" color="orange.500">
                    戻る
                </Link>
            </HStack>

            <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
                <Stack spacing={4}>
                    <FormControl>
                        <FormLabel>企画書CSVファイル</FormLabel>
                        <Input type="file" accept=".csv,text/csv" onChange={onFileChange} />
                        <FormHelperText>UTF-8 の CSV をアップロードしてください。</FormHelperText>
                        <Text mt={1} fontSize="sm" color="gray.600">選択中: {selectedFileLabel}</Text>
                    </FormControl>

                    <Button colorScheme="blue" onClick={onSubmit} isLoading={submitting}>
                        CSVを添削して結果を表示
                    </Button>

                    {message ? (
                        <Box rounded="xl" bg="green.50" borderWidth="1px" borderColor="green.200" p={4}>
                            <Text fontSize="sm" color="green.700">{message}</Text>
                        </Box>
                    ) : null}

                    {error ? (
                        <Box rounded="xl" bg="red.50" borderWidth="1px" borderColor="red.200" p={4}>
                            <Text fontSize="sm" color="red.700">{error}</Text>
                        </Box>
                    ) : null}

                    {downloadUrl ? (
                        <HStack>
                            <Button as="a" href={downloadUrl} download={downloadName} colorScheme="green">
                                添削済みCSVをダウンロード
                            </Button>
                            <Text fontSize="sm" color="gray.600">{downloadName}</Text>
                        </HStack>
                    ) : null}
                </Stack>
            </Box>

            {fakeLoading ? (
                <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
                    <HStack spacing={3}>
                        <Spinner size="sm" />
                        <Text fontSize="sm" color="gray.700">
                            添削アドバイスを生成中です...
                        </Text>
                    </HStack>
                </Box>
            ) : null}

            {showDemoAdvice ? (
                <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
                    <Stack spacing={4}>
                        <Box>
                            <Text fontWeight="bold" fontSize="sm">🌟 全体コメント</Text>
                            <Stack mt={1} spacing={1}>
                                {DEMO_ADVICE.overall.map((line) => (
                                    <Text key={line} fontSize="sm">{line}</Text>
                                ))}
                            </Stack>
                        </Box>

                        <Box>
                            <Text fontWeight="bold" fontSize="sm">👍 良いところ</Text>
                            <Stack mt={1} spacing={1}>
                                {DEMO_ADVICE.goodPoints.map((line) => (
                                    <Text key={line} fontSize="sm">{line}</Text>
                                ))}
                            </Stack>
                        </Box>

                        <Box>
                            <Text fontWeight="bold" fontSize="sm">🤔 もう一歩なところ</Text>
                            <Stack mt={1} spacing={1}>
                                {DEMO_ADVICE.improvePoints.map((line) => (
                                    <Text key={line} fontSize="sm">{line}</Text>
                                ))}
                            </Stack>
                        </Box>

                        <Box>
                            <Text fontWeight="bold" fontSize="sm">💡 改善提案</Text>
                            <Stack mt={1} spacing={1}>
                                {DEMO_ADVICE.proposals.map((line) => (
                                    <Text key={line} fontSize="sm">{line}</Text>
                                ))}
                            </Stack>
                        </Box>

                        <Box>
                            <Text fontWeight="bold" fontSize="sm">🎯 最終評価</Text>
                            <Stack mt={1} spacing={1}>
                                {DEMO_ADVICE.final.map((line) => (
                                    <Text key={line} fontSize="sm">{line}</Text>
                                ))}
                            </Stack>
                        </Box>
                    </Stack>
                </Box>
            ) : null}

            {summaryRows.length > 0 ? (
                <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
                    <Heading size="md" mb={3}>総評</Heading>
                    <Stack spacing={3}>
                        {summaryRows.map((row, idx) => (
                            <Box key={`${row.proposalId}-${idx}`} rounded="lg" bg="gray.50" p={3}>
                                <Text fontSize="sm" fontWeight="bold">{row.proposalId} / {row.municipalityCode}</Text>
                                <Text fontSize="sm" mt={1}>{row.overall || "総評なし"}</Text>
                            </Box>
                        ))}
                    </Stack>
                </Box>
            ) : null}

            {reviewRows.length > 0 ? (
                <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
                    <Heading size="md" mb={3}>添削結果とアドバイス</Heading>
                    <Stack spacing={3}>
                        {reviewRows.map((row, idx) => (
                            <Box key={`${row.proposalId}-${row.section}-${idx}`} rounded="lg" borderWidth="1px" p={4}>
                                <HStack justify="space-between" align="start">
                                    <Text fontSize="sm" fontWeight="bold">{row.proposalId} / {row.section}</Text>
                                    <Text fontSize="xs" color="gray.600">{row.importance}・{row.classification}</Text>
                                </HStack>
                                <Text fontSize="sm" mt={2}><b>問題点:</b> {row.issue}</Text>
                                <Text fontSize="sm" mt={1}><b>提案:</b> {row.suggestion}</Text>
                                {row.alternative ? <Text fontSize="sm" mt={1}><b>代替案:</b> {row.alternative}</Text> : null}
                                <Text fontSize="xs" mt={2} color="gray.600"><b>根拠:</b> {row.evidence}</Text>
                            </Box>
                        ))}
                    </Stack>
                </Box>
            ) : null}
        </Stack>
    );
}
