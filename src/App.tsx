/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import MemoryDashboard from "./components/MemoryDashboard";
import { Toaster } from "@/components/ui/sonner";

export default function App() {
  return (
    <>
      <MemoryDashboard />
      <Toaster />
    </>
  );
}

