"use client";

import NextLink from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Box, Button, Heading, HStack, Link, Spinner, Stack, Text } from "@chakra-ui/react";
import { api, Policy } from "../../../../lib/api";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export default function PolicyDetailPage() {
  const params = useParams<{ policyId: string }>();
  const router = useRouter();
  const [policy, setPolicy] = useState<Policy | null>(null);

  useEffect(() => {
    api.policy(params.policyId)
      .then((res) => setPolicy(res.policy))
      .catch(() => router.push("/login"));
  }, [params.policyId, router]);

  const pdfUrl = useMemo(() => {
    if (!policy?.pdfUrl) return null;
    return `${API_BASE}${policy.pdfUrl}`;
  }, [policy?.pdfUrl]);

  if (!policy) {
    return (
      <HStack>
        <Spinner size="sm" />
        <Text>読み込み中...</Text>
      </HStack>
    );
  }

  return (
    <Stack spacing={6}>
      <HStack justify="space-between">
        <Heading size="lg">施策PDF閲覧</Heading>
        <Link as={NextLink} href="/app/search" fontSize="sm" fontWeight="semibold" color="blue.600">
          戻る
        </Link>
      </HStack>

      <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
        <Text fontSize="sm" color="gray.500">
          {policy.municipalityName}
        </Text>
        <Heading mt={2} size="lg">
          {policy.title}
        </Heading>

        {pdfUrl ? (
          <Stack mt={4} spacing={3}>
            <Button as="a" href={pdfUrl} target="_blank" rel="noreferrer" width="fit-content" colorScheme="blue" variant="outline">
              PDFを新しいタブで開く
            </Button>
            <Box borderWidth="1px" rounded="md" overflow="hidden" h="75vh">
              <iframe title={policy.title} src={pdfUrl} width="100%" height="100%" style={{ border: 0 }} />
            </Box>
          </Stack>
        ) : (
          <Text mt={4} color="gray.700">
            この施策にはPDFが紐付いていません。`policies.json` に `pdfPath` を設定してください。
          </Text>
        )}
      </Box>
    </Stack>
  );
}