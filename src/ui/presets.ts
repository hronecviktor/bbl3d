// Chart presets: groups of fields that are useful side by side.
export interface Preset {
  id: string;
  label: string;
  fields: string[];
}

export const PRESETS: Preset[] = [
  { id: "roll", label: "Roll: setpoint vs gyro", fields: ["setpoint[0]", "gyroADC[0]"] },
  { id: "pitch", label: "Pitch: setpoint vs gyro", fields: ["setpoint[1]", "gyroADC[1]"] },
  { id: "yaw", label: "Yaw: setpoint vs gyro", fields: ["setpoint[2]", "gyroADC[2]"] },
  { id: "motors", label: "Motors", fields: ["motor[0]", "motor[1]", "motor[2]", "motor[3]"] },
  { id: "erpm", label: "Motor RPM", fields: ["eRPM[0]", "eRPM[1]", "eRPM[2]", "eRPM[3]"] },
  { id: "battery", label: "Battery", fields: ["vbatLatest", "amperageLatest"] },
  { id: "rc", label: "RC sticks", fields: ["rcCommand[0]", "rcCommand[1]", "rcCommand[2]", "rcCommand[3]"] },
  { id: "pidRoll", label: "PID roll (P, I, D, F)", fields: ["axisP[0]", "axisI[0]", "axisD[0]", "axisF[0]"] },
  { id: "pidPitch", label: "PID pitch (P, I, D, F)", fields: ["axisP[1]", "axisI[1]", "axisD[1]", "axisF[1]"] },
  { id: "pidYaw", label: "PID yaw (P, I, F)", fields: ["axisP[2]", "axisI[2]", "axisF[2]"] },
  { id: "gyroRaw", label: "Gyro raw vs filtered", fields: ["gyroUnfilt[0]", "gyroADC[0]", "gyroUnfilt[1]", "gyroADC[1]"] },
  { id: "altitude", label: "Altitude & speed", fields: ["baroAlt", "GPS_altitude", "GPS_speed"] },
  { id: "attitude", label: "Attitude (GPS-aided estimate)", fields: ["attitude.roll", "attitude.pitch"] },
  { id: "link", label: "Radio link", fields: ["rssi", "rxSignalReceived", "failsafePhase"] },
];

export const DEFAULT_PANELS = ["roll", "motors"];

export const PALETTE = ["#4e9cff", "#ff8a3d", "#45c47a", "#e2559c", "#b39cff", "#e6c54a", "#4fd1d9", "#ff6b6b"];
