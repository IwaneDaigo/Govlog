"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertIcon, Box, Button, FormControl, FormLabel, Heading, Input, Select, Stack, Text } from "@chakra-ui/react";
import { api, MunicipalityOption } from "../../lib/api";

export default function LoginPage() {
  const router = useRouter();
  const [municipalityCode, setMunicipalityCode] = useState("");
  const [allOptions, setAllOptions] = useState<MunicipalityOption[]>([]);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    api.me()
      .then(() => router.replace("/app/search"))
      .catch(() => undefined);
  }, [router]);

  useEffect(() => {
    setOptionsLoading(true);
    setOptionsError(null);
    api.municipalities("", 2000)
      .then((res) => setAllOptions(res.municipalities))
      .catch((err) => {
        setAllOptions([]);
        setOptionsError(err instanceof Error ? err.message : "自治体一覧の取得に失敗しました。");
      })
      .finally(() => setOptionsLoading(false));
  }, []);

  const filteredOptions = useMemo(() => {
    const query = municipalityCode.trim().toLowerCase();
    if (!query) return allOptions;
    return allOptions.filter(
      (item) =>
        item.code.toLowerCase().includes(query) ||
        item.displayName.toLowerCase().includes(query) ||
        item.name.toLowerCase().includes(query)
    );
  }, [allOptions, municipalityCode]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      await api.login(municipalityCode);
      router.replace("/app/search");
    } catch (err) {
      setError(err instanceof Error ? err.message : "ログインに失敗しました。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Box mx="auto" mt={16} maxW="md" rounded="2xl" bg="white" p={8} shadow="sm" borderWidth="1px">
      <Heading size="lg">Gov-Sync ログイン</Heading>
      <Text mt={2} color="gray.600">
        自治体コードを入力してログインしてください。
      </Text>

      <form onSubmit={onSubmit}>
        <Stack mt={6} spacing={4}>
          <FormControl>
            <FormLabel>自治体コード入力</FormLabel>
            <Input value={municipalityCode} onChange={(e) => setMunicipalityCode(e.target.value)} placeholder="例: 13101" />
          </FormControl>

          <FormControl isRequired>
            <FormLabel>自治体コード一覧</FormLabel>
            <Select
              placeholder="自治体を選択"
              value={filteredOptions.some((item) => item.code === municipalityCode) ? municipalityCode : ""}
              onChange={(e) => setMunicipalityCode(e.target.value)}
              isDisabled={optionsLoading || !!optionsError}
            >
              {filteredOptions.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code} {item.displayName}
                </option>
              ))}
            </Select>
            <Text mt={1} fontSize="xs" color="gray.500">
              {optionsLoading ? "読み込み中..." : `表示件数: ${filteredOptions.length}`}
            </Text>
            {optionsError ? (
              <Text mt={1} fontSize="xs" color="red.500">
                一覧取得エラー: {optionsError}
              </Text>
            ) : null}
          </FormControl>

          {error ? (
            <Alert status="error" rounded="md">
              <AlertIcon />
              {error}
            </Alert>
          ) : null}

          <Button type="submit" colorScheme="blue" isLoading={submitting} loadingText="ログイン中...">
            ログイン
          </Button>
        </Stack>
      </form>
    </Box>
  );
}
