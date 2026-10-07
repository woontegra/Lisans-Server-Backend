export type SeedAdminRow = {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
};

/** İlk kurulumda yönetici yoksa hesap açar. Var olan satırın e-posta, parola ve adını değiştirmez. */
export async function ensureFirstAdmin(input: {
  existing: SeedAdminRow | null;
  email: string | undefined;
  password: string | undefined;
  hashPassword: (password: string) => Promise<string>;
  create: (data: { email: string; passwordHash: string; name: string }) => Promise<SeedAdminRow>;
}): Promise<{ created: boolean; admin: SeedAdminRow }> {
  if (input.existing) {
    return { created: false, admin: input.existing };
  }
  if (!input.email || !input.password) {
    throw new Error('ADMIN_EMAIL ve ADMIN_PASSWORD ortam değişkenleri gerekli');
  }
  const admin = await input.create({
    email: input.email,
    passwordHash: await input.hashPassword(input.password),
    name: 'Woontegra Admin',
  });
  return { created: true, admin };
}
