// THIS FILE IS READ ONLY. Do not touch this file unless you are correctly adding a new auth provider in accordance to the vly auth documentation

import { convexAuth } from "@convex-dev/auth/server";
import { Anonymous } from "@convex-dev/auth/providers/Anonymous";
import { Password } from "@convex-dev/auth/providers/Password";
import { emailOtp } from "./auth/emailOtp";

// Login/register dengan email + password (provider "password").
// Alur yang dipakai (dikirim lewat signIn dari klien):
//   - flow: "signIn"  -> masuk dengan akun yang sudah ada
//   - flow: "signUp"  -> daftar manual (nama + email + password)
// profile() dipakai supaya field `name` dari form register tersimpan.
const password = Password({
  profile: (params) => ({
    email: params.email as string,
    ...(params.name ? { name: params.name as string } : {}),
  }),
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [password, emailOtp, Anonymous],
});