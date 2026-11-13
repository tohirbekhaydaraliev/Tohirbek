/** Foydalanuvchi xatosi (noto'g'ri kiritish, topilmadi) — API'da 4xx sifatida qaytadi. */
export class UserError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409 = 400) {
    super(message);
  }
}
