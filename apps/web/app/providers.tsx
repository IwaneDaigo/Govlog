"use client";

import { Box, ChakraProvider, Container, extendTheme } from "@chakra-ui/react";
import { ReactNode } from "react";

const theme = extendTheme({
  styles: {
    global: {
      body: {
        bg: "gray.50",
        color: "gray.800"
      }
    }
  }
});

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <ChakraProvider theme={theme}>
      <Box minH="100vh" py={6}>
        <Container maxW="5xl">{children}</Container>
      </Box>
    </ChakraProvider>
  );
}
