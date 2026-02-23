"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  FormControl,
  FormLabel,
  Heading,
  HStack,
  Input,
  Link,
  Stack,
  Table,
  Tbody,
  Td,
  Text,
  Th,
  Thead,
  Tr
} from "@chakra-ui/react";
import { api, ImportPdfPreviewItem, Municipality } from "../../../lib/api";

const slugify = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export default function ImportPdfPage() {
  const router = useRouter();
  const [municipality, setMunicipality] = useState<Municipality | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [idPrefix, setIdPrefix] = useState("");
  const [outDir, setOutDir] = useState("");
  const [policiesOutPath, setPoliciesOutPath] = useState("");
  const [mergeToPoliciesJson, setMergeToPoliciesJson] = useState(true);

  const [previewToken, setPreviewToken] = useState<string | null>(null);
  const [previewItems, setPreviewItems] = useState<ImportPdfPreviewItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [previewMeta, setPreviewMeta] = useState<{ pageCount: number; segmentCount: number } | null>(null);

  const [submitting, setSubmitting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.me()
      .then((res) => setMunicipality(res.municipality))
      .catch(() => router.push("/login"));
  }, [router]);

  const defaultPrefix = useMemo(() => {
    if (!municipality) return "";
    const codePart = municipality.code.replace(/[^\dA-Za-z_-]/g, "");
    return `${slugify(codePart)}-r${new Date().getFullYear()}`;
  }, [municipality]);

  useEffect(() => {
    if (!municipality) return;
    if (!idPrefix) setIdPrefix(defaultPrefix);
    if (!outDir) setOutDir(`data/policies-pdf/${municipality.code}`);
    if (!policiesOutPath) setPoliciesOutPath(`data/policies.${municipality.code}.json`);
  }, [municipality, defaultPrefix, idPrefix, outDir, policiesOutPath]);

  const toggleSelection = (id: string) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]));
  };

  const selectAll = () => setSelectedIds(previewItems.map((item) => item.id));
  const clearAll = () => setSelectedIds([]);

  const onPreview = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedFile) {
      setError("PDFファイルを選択してください。");
      return;
    }
    if (!idPrefix.trim()) {
      setError("IDプレフィックスは必須です。");
      return;
    }

    setSubmitting(true);
    setError(null);
    setMessage(null);
    setPreviewToken(null);
    setPreviewItems([]);
    setSelectedIds([]);
    setPreviewMeta(null);

    try {
      const res = await api.importPdfUploadPreview(selectedFile, {
        idPrefix: idPrefix.trim(),
        outDir: outDir.trim() || undefined,
        policiesOutPath: policiesOutPath.trim() || undefined,
        municipalityCode: municipality?.code,
        mergeToPoliciesJson
      });
      setPreviewToken(res.token);
      setPreviewItems(res.preview.previewItems);
      setSelectedIds(res.preview.previewItems.map((item) => item.id));
      setPreviewMeta({
        pageCount: res.preview.pageCount,
        segmentCount: res.preview.segmentCount
      });
      setMessage("プレビュー生成が完了しました。誤りがある項目は除外してから確定実行してください。");
    } catch (e) {
      setError(e instanceof Error ? e.message : "プレビュー生成に失敗しました。");
    } finally {
      setSubmitting(false);
    }
  };

  const onConfirm = async () => {
    if (!previewToken) return;
    if (selectedIds.length === 0) {
      setError("取り込む項目を1件以上選択してください。");
      return;
    }
    setConfirming(true);
    setError(null);
    try {
      const res = await api.confirmImportPdfUpload(previewToken, selectedIds);
      setMessage(
        `完了: ${res.result.segmentCount}件抽出（${res.result.pageCount}ページ） / 反映件数: ${res.result.mergedAdded ?? 0}`
      );
      setPreviewToken(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "確定実行に失敗しました。");
    } finally {
      setConfirming(false);
    }
  };

  const onDeleteSelected = async () => {
    if (selectedIds.length === 0) {
      setError("削除する項目を選択してください。");
      return;
    }
    setDeleting(true);
    setError(null);
    try {
      const res = await api.deletePolicies(selectedIds);
      setMessage(`既存データから ${res.deletedCount} 件を削除しました。`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "削除に失敗しました。");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Stack spacing={6}>
      <HStack justify="space-between" align="start">
        <Box>
          <Heading size="lg">施策PDF取り込み</Heading>
          <Text mt={1} color="gray.600" fontSize="sm">
            プレビュー確認後に確定実行できます。誤り項目は除外または削除してください。
          </Text>
        </Box>
        <Link as={NextLink} href="/app/search" fontSize="sm" fontWeight="semibold" color="blue.600">
          戻る
        </Link>
      </HStack>

      <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
        <form onSubmit={onPreview}>
          <Stack spacing={4}>
            <FormControl isRequired>
              <FormLabel>PDFファイル</FormLabel>
              <Input
                type="file"
                accept=".pdf,application/pdf"
                onChange={(e) => setSelectedFile(e.target.files?.[0] ?? null)}
                p={1}
              />
            </FormControl>

            <FormControl isRequired>
              <FormLabel>IDプレフィックス</FormLabel>
              <Input value={idPrefix} onChange={(e) => setIdPrefix(e.target.value)} placeholder="例: kobe-r25" />
            </FormControl>

            <FormControl>
              <FormLabel>出力PDFフォルダ</FormLabel>
              <Input value={outDir} onChange={(e) => setOutDir(e.target.value)} placeholder="例: data/policies-pdf/kobe" />
            </FormControl>

            <FormControl>
              <FormLabel>抽出JSON出力パス</FormLabel>
              <Input
                value={policiesOutPath}
                onChange={(e) => setPoliciesOutPath(e.target.value)}
                placeholder="例: data/policies.kobe.json"
              />
            </FormControl>

            <Checkbox isChecked={mergeToPoliciesJson} onChange={(e) => setMergeToPoliciesJson(e.target.checked)}>
              `data/policies.json` に自動反映する
            </Checkbox>

            <Button type="submit" colorScheme="blue" isLoading={submitting}>
              プレビュー生成
            </Button>
          </Stack>
        </form>
      </Box>

      {previewMeta ? (
        <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
          <HStack justify="space-between" mb={3}>
            <Heading size="sm">確認画面（分割・抽出結果）</Heading>
            <Badge colorScheme="blue">
              {selectedIds.length}/{previewMeta.segmentCount} 件選択
            </Badge>
          </HStack>
          <HStack mb={3}>
            <Button size="sm" variant="outline" onClick={selectAll}>
              全選択
            </Button>
            <Button size="sm" variant="outline" onClick={clearAll}>
              全解除
            </Button>
          </HStack>
          <Box overflowX="auto">
            <Table size="sm">
              <Thead>
                <Tr>
                  <Th>取込</Th>
                  <Th>ID</Th>
                  <Th>タイトル</Th>
                  <Th>ページ範囲</Th>
                </Tr>
              </Thead>
              <Tbody>
                {previewItems.map((item) => (
                  <Tr key={item.id}>
                    <Td>
                      <Checkbox isChecked={selectedIds.includes(item.id)} onChange={() => toggleSelection(item.id)} />
                    </Td>
                    <Td>{item.id}</Td>
                    <Td>{item.title}</Td>
                    <Td>
                      {item.startPage}-{item.endPage} ({item.pageCount}p)
                    </Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          </Box>
          <HStack mt={4}>
            <Button colorScheme="green" onClick={onConfirm} isLoading={confirming} isDisabled={!previewToken}>
              選択項目で確定実行
            </Button>
            <Button colorScheme="red" variant="outline" onClick={onDeleteSelected} isLoading={deleting}>
              選択項目を既存データから削除
            </Button>
          </HStack>
        </Box>
      ) : null}

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
  );
}

