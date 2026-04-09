/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter } from "react-router-dom";

import DatabaseConsole from "./components/DatabaseConsole";
import { Toaster } from "@/components/ui/sonner";

export default function App() {
  return (
    <>
      <BrowserRouter>
        <DatabaseConsole />
      </BrowserRouter>
      <Toaster />
    </>
  );
}

