"use client";

import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  Badge,
  Box,
  Heading,
  HStack,
  Link,
  Progress,
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
  similarCities?: TwinCity[];
  worstCities?: TwinCity[];
  policies: Policy[];
};

const toScore100 = (score: number): number => {
  const normalized = score <= 1 && score >= -1 ? ((score + 1) / 2) * 100 : score * 100;
  return Math.max(0, Math.min(100, normalized));
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

  const similarCities = data?.similarCities ?? data?.top5Cities ?? [];
  const worstCities = data?.worstCities ?? [];

  const scoreByMunicipality = useMemo(() => {
    const map = new Map<string, number>();
    similarCities.forEach((city) => {
      map.set(city.municipalityCode, toScore100(city.score));
    });
    return map;
  }, [similarCities]);

  useEffect(() => {
    if (!data) return;
    const scoreRows = similarCities.map((city) => ({
      municipalityCode: city.municipalityCode,
      municipalityName: city.municipalityName,
      scoreRaw: city.score,
      score100: Number(toScore100(city.score).toFixed(1))
    }));
    // Temporary debug log for score validation in browser console.
    console.log("[Gov-Sync] 類似度スコア一覧", scoreRows);
  }, [data, similarCities]);

  return (
    <Stack spacing={6}>
      <HStack justify="space-between" align="start">
        <Box>
          <Heading size="lg">検索結果</Heading>
          <Text mt={1} color="gray.600" fontSize="sm">
            キーワード: {keyword || "未入力"}
          </Text>
        </Box>
        <Link as={NextLink} href="/app/search" fontSize="sm" fontWeight="semibold" color="orange.500">
          戻る
        </Link>
      </HStack>

      <Box rounded="2xl" p={6} borderWidth="1px" bg="orange.50">
        <Heading size="md">似ている自治体 TOP5</Heading>
        <Text mt={1} fontSize="sm" color="gray.600">
          類似度を100点満点で表示しています
        </Text>
        <SimpleGrid mt={4} spacing={3} minChildWidth="190px">
          {(data?.top5Cities ?? []).map((city) => {
            const score100 = toScore100(city.score);
            return (
              <Box key={city.municipalityCode} rounded="xl" borderWidth="1px" bg="white" p={4}>
                <Text fontSize="xs" color="gray.500">
                  {city.municipalityCode}
                </Text>
                <Text mt={1} fontWeight="semibold" fontSize="sm">
                  {city.municipalityName}
                </Text>
                <HStack mt={2} justify="space-between">
                  <Text fontSize="xs" color="gray.600">
                    類似度スコア
                  </Text>
                  <Badge colorScheme="orange" borderRadius="full" px={2}>
                    {score100.toFixed(1)}点
                  </Badge>
                </HStack>
                <Progress mt={2} value={score100} size="sm" borderRadius="full" colorScheme="orange" />
              </Box>
            );
          })}
        </SimpleGrid>
      </Box>

      <Box rounded="2xl" p={6} borderWidth="1px" bg="white">
        <Heading size="md">類似自治体ランキング（TOP20）</Heading>
        <Text mt={1} fontSize="sm" color="gray.600">
          TOP5以外も含めて確認できます
        </Text>
        <Stack mt={4} spacing={2}>
          {similarCities.map((city, idx) => {
            const score100 = toScore100(city.score);
            return (
              <HStack
                key={`${city.municipalityCode}-${idx}`}
                justify="space-between"
                borderWidth="1px"
                rounded="lg"
                px={3}
                py={2}
              >
                <HStack>
                  <Badge colorScheme="gray" minW="28px" textAlign="center">
                    {idx + 1}
                  </Badge>
                  <Text fontSize="sm">{city.municipalityName}</Text>
                  <Text fontSize="xs" color="gray.500">
                    ({city.municipalityCode})
                  </Text>
                </HStack>
                <Badge colorScheme="orange" variant="subtle">
                  {score100.toFixed(1)}点
                </Badge>
              </HStack>
            );
          })}
          {!loading && similarCities.length === 0 ? (
            <Text fontSize="sm" color="orange.700">
              類似度データを取得できませんでした。Python類似度サービスの接続設定を確認してください。
            </Text>
          ) : null}
        </Stack>
      </Box>

      <Box rounded="2xl" p={6} borderWidth="1px" bg="white">
        <Heading size="md">類似自治体ランキング（ワースト20）</Heading>
        <Text mt={1} fontSize="sm" color="gray.600">
          類似度が低い自治体です
        </Text>
        <Stack mt={4} spacing={2}>
          {worstCities.map((city, idx) => {
            const score100 = toScore100(city.score);
            return (
              <HStack
                key={`${city.municipalityCode}-worst-${idx}`}
                justify="space-between"
                borderWidth="1px"
                rounded="lg"
                px={3}
                py={2}
              >
                <HStack>
                  <Badge colorScheme="gray" minW="28px" textAlign="center">
                    {idx + 1}
                  </Badge>
                  <Text fontSize="sm">{city.municipalityName}</Text>
                  <Text fontSize="xs" color="gray.500">
                    ({city.municipalityCode})
                  </Text>
                </HStack>
                <Badge colorScheme="red" variant="subtle">
                  {score100.toFixed(1)}点
                </Badge>
              </HStack>
            );
          })}
          {!loading && worstCities.length === 0 ? (
            <Text fontSize="sm" color="gray.600">
              ワースト20のデータはありません。
            </Text>
          ) : null}
        </Stack>
      </Box>

      <Stack spacing={3}>
        <Heading size="md">類似自治体の施策一覧</Heading>
        {loading ? (
          <HStack>
            <Spinner size="sm" />
            <Text>読み込み中...</Text>
          </HStack>
        ) : null}
        {!loading && (data?.policies.length ?? 0) === 0 ? <Text>類似自治体で一致する施策はありません。</Text> : null}

        {(data?.policies ?? []).map((policy: Policy) => {
          const score = scoreByMunicipality.get(policy.municipalityCode);
          return (
            <Box key={policy.id} rounded="2xl" bg="white" p={5} shadow="sm" borderWidth="1px">
              <HStack justify="space-between" align="start">
                <Text fontSize="xs" color="gray.500">
                  {policy.municipalityName}
                </Text>
                {score !== undefined ? (
                  <Badge colorScheme="orange" variant="subtle">
                    類似度 {score.toFixed(1)}点
                  </Badge>
                ) : null}
              </HStack>
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
                <Link as={NextLink} href={`/app/policies/${policy.id}`} fontSize="sm" fontWeight="semibold" color="orange.500">
                  詳細を見る
                </Link>
              </HStack>
            </Box>
          );
        })}
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
