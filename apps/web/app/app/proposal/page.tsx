"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import NextLink from "next/link";
import { useRouter } from "next/navigation";
import {
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
import { api, Municipality } from "../../../lib/api";

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
  { key: "approach", label: "実施内容", placeholder: "具体的な取り組み内容" },
  { key: "schedule", label: "スケジュール", placeholder: "開始〜完了までの計画" },
  { key: "budget", label: "予算・費用感", placeholder: "概算や内訳の要点" },
  { key: "stakeholders", label: "関係者", placeholder: "関係部署・外部パートナーなど" },
  { key: "effects", label: "期待効果", placeholder: "定量・定性の効果" },
  { key: "risks", label: "リスク・留意点", placeholder: "想定リスクと対応" },
  { key: "notes", label: "補足", placeholder: "その他共有したい情報" }
];

export default function ProposalPage() {
  const router = useRouter();
  const [municipality, setMunicipality] = useState<Municipality | null>(null);
  const [title, setTitle] = useState("");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
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
    if (!title) {
      setTitle(`${municipality.name} 企画書`);
    }
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
              <FormControl key={field.key}>
                <FormLabel>{field.label}</FormLabel>
                <Textarea
                  value={fields[field.key] ?? ""}
                  onChange={(e) => setFields((prev) => ({ ...prev, [field.key]: e.target.value }))}
                  placeholder={field.placeholder}
                  rows={3}
                />
              </FormControl>
            ))}

            <Button type="submit" colorScheme="blue" isLoading={submitting}>
              PDFを作成
            </Button>
          </Stack>
        </form>
      </Box>

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
