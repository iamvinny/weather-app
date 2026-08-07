import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

type Props = {
  scenes: string[];
  selected: string;
  onSelect: (name: string) => void;
};

/**
 * Debug control for browsing the extracted scenes. Not part of the weather UI —
 * it exists so every converted condition can be eyeballed on device.
 */
export const ScenePicker = ({ scenes, selected, onSelect }: Props) => (
  <View style={styles.grid}>
    {scenes.map((name) => (
      <Pressable
        key={name}
        onPress={() => onSelect(name)}
        style={[styles.chip, selected === name && styles.chipOn]}
      >
        <Text style={styles.chipText}>{name.replace(/_/g, " ")}</Text>
      </Pressable>
    ))}
  </View>
);

const styles = StyleSheet.create({
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  chipOn: { backgroundColor: "rgba(255,255,255,0.32)" },
  chipText: { color: "#fff", fontSize: 12, fontWeight: "600" },
});
