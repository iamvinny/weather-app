import React from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  children?: React.ReactNode;
};

const HOURS = Array.from({ length: 10 }, (_, i) => ({
  time: `${(i + 1) * 2}:00`,
  temp: `${11 + (i % 4)}°`,
}));

/**
 * The translucent sheet that scrolls over the scene. Its material is what lets
 * the collapsed background read through the top edge.
 */
export const ForecastSheet = ({ children }: Props) => (
  <View style={styles.sheet}>
    {children}
    {HOURS.map((h) => (
      <View key={h.time} style={styles.card}>
        <Text style={styles.cardText}>{h.time}</Text>
        <Text style={styles.cardText}>{h.temp}</Text>
      </View>
    ))}
  </View>
);

const styles = StyleSheet.create({
  sheet: {
    backgroundColor: "rgba(10,22,38,0.75)",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    padding: 20,
    gap: 12,
    minHeight: 700,
  },
  card: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.12)",
  },
  cardText: { color: "#fff", fontSize: 16 },
});
