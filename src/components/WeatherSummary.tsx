import React from "react";
import { StyleSheet, Text, View } from "react-native";

type Props = {
  city: string;
  temperature: string;
  condition: string;
  high: string;
  low: string;
};

/** Current conditions and daily range, sitting over the scene. */
export const WeatherSummary = ({ city, temperature, condition, high, low }: Props) => {
  const hasDegree = temperature.endsWith("°");
  const temperatureValue = hasDegree ? temperature.slice(0, -1) : temperature;

  return (
    <View style={styles.summary}>
      <Text style={styles.city}>{city}</Text>
      <View style={styles.temperatureRow} accessibilityLabel={temperature}>
        <Text style={styles.temp}>{temperatureValue}</Text>
        {hasDegree && (
          <Text style={styles.degree} accessibilityElementsHidden>
            °
          </Text>
        )}
      </View>
      <Text style={styles.cond}>{condition}</Text>
      <Text style={styles.range}>{`H:${high} L:${low}`}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  summary: {
    alignItems: "center",
    alignSelf: "stretch",
    paddingHorizontal: 24,
    paddingTop: 120,
  },
  city: {
    alignSelf: "center",
    color: "#fff",
    fontSize: 34,
    fontWeight: "400",
    lineHeight: 41,
    textAlign: "center",
  },
  temperatureRow: {
    alignSelf: "center",
    position: "relative",
  },
  temp: {
    color: "#fff",
    fontSize: 96,
    fontWeight: "200",
    lineHeight: 106,
    textAlign: "center",
  },
  degree: {
    color: "#fff",
    fontSize: 50,
    fontWeight: "300",
    lineHeight: 58,
    position: "absolute",
    right: -16,
    top: 5,
  },
  cond: {
    alignSelf: "center",
    color: "rgba(255,255,255,0.72)",
    fontSize: 20,
    fontWeight: "500",
    lineHeight: 24,
    textAlign: "center",
  },
  range: {
    alignSelf: "center",
    color: "#fff",
    fontSize: 20,
    fontWeight: "500",
    lineHeight: 25,
    textAlign: "center",
  },
});
