import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";

export default function RootLayout() {
  return (
    <>
      <StatusBar style="light" />
      {/* The scene is the whole screen, so no chrome above it. */}
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: "#0b1420" } }} />
    </>
  );
}
