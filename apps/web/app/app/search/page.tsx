"use client";

import { FormEvent, useEffect, useState } from "react";
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
  Text
} from "@chakra-ui/react";
import { api, Municipality } from "../../../lib/api";

export default function SearchPage() {
  const router = useRouter();
  const [keyword, setKeyword] = useState("");
  const [municipality, setMunicipality] = useState<Municipality | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);

  useEffect(() => {
    api.me()
      .then((res) => setMunicipality(res.municipality))
      .catch(() => router.push("/login"));
  }, [router]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    router.push(`/app/results?keyword=${encodeURIComponent(keyword)}`);
  };

  const onLogout = async () => {
    setLoggingOut(true);
    try {
      await api.logout();
    } finally {
      router.replace("/login");
    }
  };

  return (
    <Stack spacing={6}>
      <HStack justify="space-between" align="start">
        <Box>
          <Heading size="lg">検索ページ</Heading>
          <Text mt={1} color="gray.600" fontSize="sm">
            ログイン自治体 {municipality ? `${municipality.name} (${municipality.code})` : "ログイン情報を確認中..."}
          </Text>
        </Box>
        <Button variant="outline" onClick={onLogout} isLoading={loggingOut} loadingText="ログアウト中...">
          ログアウト
        </Button>
      </HStack>

      <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
        <form onSubmit={onSubmit}>
          <FormControl>
            <FormLabel>キーワード</FormLabel>
            <Input
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="例: 防災, 子育て, DX"
            />
          </FormControl>

          <Button type="submit" mt={4} colorScheme="blue">
            検索
          </Button>
        </form>
      </Box>

      <Box rounded="2xl" bg="white" p={6} shadow="sm" borderWidth="1px">
        <Heading size="sm">その他の操作</Heading>
        <Text mt={2} fontSize="sm" color="gray.600">
          施策PDFの取り込みや企画書の作成ができます。
        </Text>
        <HStack mt={3} spacing={4}>
          <Link as={NextLink} href="/app/import" color="blue.600" fontWeight="semibold">
            施策PDF取り込み
          </Link>
          <Link as={NextLink} href="/app/proposal" color="orange.500" fontWeight="semibold">
            企画書を作成
          </Link>
        </HStack>
      </Box>
    </Stack>
  );
}
