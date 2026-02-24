"use client";

import NextLink from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import {
  Accordion,
  AccordionButton,
  AccordionIcon,
  AccordionItem,
  AccordionPanel,
  Badge,
  Box,
  Button,
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

const PAGE_SIZE = 12;

const toScore100 = (score: number): number => {
  const normalized = score <= 1 && score >= -1 ? ((score + 1) / 2) * 100 : score * 100;
  return Math.max(0, Math.min(100, normalized));
};

const AXIS_LABELS: Record<string, string> = {
  need: "ニーズ",
  support: "支援性",
  feasibility: "実現性"
};

function AxisBreakdown({ axisScore }: { axisScore: { need: number; support: number; feasibility: number } }) {
  const axes = (["need", "support", "feasibility"] as const).filter((k) => axisScore[k] > 0);
  if (axes.length === 0) return null;

  return (
    <Stack mt={2} spacing={1}>
      {axes.map((k) => {
        const pct = Math.round(axisScore[k] * 100);
        return (
          <HStack key={k} spacing={2}>
            <Text fontSize="xs" color="gray.500" w="44px" flexShrink={0}>
              {AXIS_LABELS[k]}
            </Text>
            <Progress value={pct} size="xs" borderRadius="full" colorScheme="orange" flex={1} />
            <Text fontSize="xs" color="gray.600" w="36px" textAlign="right">
              {pct}%
            </Text>
          </HStack>
        );
      })}
    </Stack>
  );
}

function CityRankingList({
  title,
  description,
  cities,
  scoreScheme
}: {
  title: string;
  description: string;
  cities: TwinCity[];
  scoreScheme: "orange" | "red";
}) {
  return (
    <Accordion allowToggle defaultIndex={[]} borderWidth="1px" rounded="2xl" bg="white">
      <AccordionItem border="none">
        <h2>
          <AccordionButton px={6} py={5}>
            <Box flex="1" textAlign="left">
              <Heading size="md">{title}</Heading>
              <Text mt={1} fontSize="sm" color="gray.600">
                {description}
              </Text>
            </Box>
            <Badge mr={3} colorScheme="gray">
              {cities.length}件
            </Badge>
            <AccordionIcon />
          </AccordionButton>
        </h2>
        <AccordionPanel px={6} pb={5}>
          <Stack spacing={2}>
            {cities.map((city, idx) => {
              const score100 = toScore100(city.score);
              return (
                <Box key={`${city.municipalityCode}-${idx}`} borderWidth="1px" rounded="lg" px={3} py={2}>
                  <HStack justify="space-between">
                    <HStack>
                      <Badge colorScheme="gray" minW="28px" textAlign="center">
                        {idx + 1}
                      </Badge>
                      <Text fontSize="sm">{city.municipalityName}</Text>
                      <Text fontSize="xs" color="gray.500">
                        ({city.municipalityCode})
                      </Text>
                    </HStack>
                    <Badge colorScheme={scoreScheme} variant="subtle">
                      {score100.toFixed(1)}点
                    </Badge>
                  </HStack>
                  {city.axisScore && <AxisBreakdown axisScore={city.axisScore} />}
                </Box>
              );
            })}
            {cities.length === 0 ? (
              <Text fontSize="sm" color="gray.600">
                データがありません。
              </Text>
            ) : null}
          </Stack>
        </AccordionPanel>
      </AccordionItem>
    </Accordion>
  );
}

function ResultsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const keyword = searchParams.get("keyword") ?? "";

  const [data, setData] = useState<SearchData | null>(null);
  const [loading, setLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setLoading(true);
    setCurrentPage(1);
    api.search(keyword)
      .then((res) => setData(res))
      .catch(() => router.push("/login"))
      .finally(() => setLoading(false));
  }, [keyword, router]);

  const similarCities = data?.similarCities ?? data?.top5Cities ?? [];
  const worstCities = data?.worstCities ?? [];
  const policies = data?.policies ?? [];

  const scoreByMunicipality = useMemo(() => {
    const map = new Map<string, number>();
    similarCities.forEach((city) => {
      map.set(city.municipalityCode, toScore100(city.score));
    });
    return map;
  }, [similarCities]);

  const axisByMunicipality = useMemo(() => {
    const map = new Map<string, { need: number; support: number; feasibility: number }>();
    similarCities.forEach((city) => {
      if (city.axisScore) {
        map.set(city.municipalityCode, city.axisScore);
      }
    });
    return map;
  }, [similarCities]);

  const totalPages = Math.max(1, Math.ceil(policies.length / PAGE_SIZE));
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const currentPolicies = policies.slice(pageStart, pageStart + PAGE_SIZE);

  const canPrev = currentPage > 1;
  const canNext = currentPage < totalPages;

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
        <Heading size="md">類似自治体 TOP5</Heading>
        <Text mt={1} fontSize="sm" color="gray.600">
          類似度を100点満点で表示
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
                    類似度
                  </Text>
                  <Badge colorScheme="orange" borderRadius="full" px={2}>
                    {score100.toFixed(1)}点
                  </Badge>
                </HStack>
                <Progress mt={2} value={score100} size="sm" borderRadius="full" colorScheme="orange" />
                {city.axisScore && <AxisBreakdown axisScore={city.axisScore} />}
              </Box>
            );
          })}
        </SimpleGrid>
      </Box>

      <CityRankingList
        title="類似自治体ランキング TOP20"
        description="折りたたみで表示/非表示を切り替えできます。"
        cities={similarCities}
        scoreScheme="orange"
      />

      <CityRankingList
        title="類似自治体ランキング WORST20"
        description="類似度が低い自治体を表示します。"
        cities={worstCities}
        scoreScheme="red"
      />

      <Stack spacing={3}>
        <HStack justify="space-between" align="end">
          <Box>
            <Heading size="md">施策一覧</Heading>
            <Text mt={1} fontSize="sm" color="gray.600">
              {policies.length}件中 {policies.length === 0 ? 0 : pageStart + 1}-
              {Math.min(pageStart + PAGE_SIZE, policies.length)}件を表示
            </Text>
          </Box>
          <HStack>
            <Button size="sm" onClick={() => setCurrentPage(1)} isDisabled={!canPrev}>
              先頭
            </Button>
            <Button size="sm" onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} isDisabled={!canPrev}>
              前へ
            </Button>
            <Text fontSize="sm" minW="90px" textAlign="center">
              {currentPage} / {totalPages}
            </Text>
            <Button size="sm" onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} isDisabled={!canNext}>
              次へ
            </Button>
            <Button size="sm" onClick={() => setCurrentPage(totalPages)} isDisabled={!canNext}>
              末尾
            </Button>
          </HStack>
        </HStack>

        {loading ? (
          <HStack>
            <Spinner size="sm" />
            <Text>読み込み中...</Text>
          </HStack>
        ) : null}

        {!loading && policies.length === 0 ? <Text>一致する施策データはありません。</Text> : null}

        {currentPolicies.map((policy: Policy) => {
          const score = scoreByMunicipality.get(policy.municipalityCode);
          const axisScore = axisByMunicipality.get(policy.municipalityCode);
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
              {axisScore ? <AxisBreakdown axisScore={axisScore} /> : null}

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
