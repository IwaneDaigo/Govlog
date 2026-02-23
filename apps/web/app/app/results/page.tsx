"use client";

import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import {
  Box,
  Heading,
  HStack,
  Link,
  SimpleGrid,
  Spinner,
  Stack,
  Tag,
  Text,
  Wrap,
  WrapItem
} from "@chakra-ui/react";
import { api, Policy, TwinCity } from "../../../lib/api";

type SearchData = {
  top5Cities: TwinCity[];
  policies: Policy[];
};

function ResultsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const keyword = searchParams.get("keyword") ?? "";

  const [data, setData] = useState<SearchData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.search(keyword)
      .then((res) => setData(res))
      .catch(() => router.push("/login"))
      .finally(() => setLoading(false));
  }, [keyword, router]);

  return (
    <Stack spacing={6}>
      <HStack justify="space-between" align="start">
        <Box>
          <Heading size="lg">検索結果</Heading>
          <Text mt={1} color="gray.600" fontSize="sm">
            キーワード: {keyword || "(なし)"}
          </Text>
        </Box>
        <Link as={NextLink} href="/app/search" fontSize="sm" fontWeight="semibold" color="blue.600">
          戻る
        </Link>
      </HStack>

      <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
        <Heading size="md">類似自治体 TOP5</Heading>
        <SimpleGrid mt={4} spacing={3} minChildWidth="170px">
          {data?.top5Cities.map((city) => (
            <Box key={city.municipalityCode} rounded="xl" borderWidth="1px" p={3}>
              <Text fontSize="sm" color="gray.500">
                {city.municipalityCode}
              </Text>
              <Text mt={1} fontWeight="semibold" fontSize="sm">
                {city.municipalityName}
              </Text>
              <Text mt={1} fontSize="xs" color="gray.600">
                類似度: {city.score.toFixed(2)}
              </Text>
            </Box>
          ))}
        </SimpleGrid>
      </Box>

      <Stack spacing={3}>
        <Heading size="md">施策一覧</Heading>
        {loading ? (
          <HStack>
            <Spinner size="sm" />
            <Text>読み込み中...</Text>
          </HStack>
        ) : null}
        {!loading && data?.policies.length === 0 ? <Text>該当する施策はありません。</Text> : null}

        {data?.policies.map((policy) => (
          <Box key={policy.id} rounded="2xl" bg="white" p={5} shadow="sm" borderWidth="1px">
            <Text fontSize="xs" color="gray.500">
              {policy.municipalityName}
            </Text>
            <Heading mt={1} size="md">
              {policy.title}
            </Heading>
            <Text mt={2} fontSize="sm" color="gray.700">
              {policy.summary && policy.summary.trim().length > 0 ? policy.summary : "詳細はPDFで確認できます。"}
            </Text>
            <HStack mt={4} justify="space-between" align="center">
              <Wrap spacing={2}>
                {(policy.keywords ?? []).map((tag) => (
                  <WrapItem key={tag}>
                    <Tag size="sm" variant="subtle" colorScheme="gray">
                      {tag}
                    </Tag>
                  </WrapItem>
                ))}
              </Wrap>
              <Link as={NextLink} href={`/app/policies/${policy.id}`} fontSize="sm" fontWeight="semibold" color="blue.600">
                詳細を見る
              </Link>
            </HStack>
          </Box>
        ))}
      </Stack>
    </Stack>
  );
}

export default function ResultsPage() {
  return (
    <Suspense fallback={<Text>読み込み中...</Text>}>
      <ResultsContent />
    </Suspense>
  );
}
