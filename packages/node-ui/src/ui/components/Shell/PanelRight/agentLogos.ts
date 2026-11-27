/**
 * Agent marks for the Connected Agents panel.
 *
 * Each logo is the vendor's own mark, reduced to a 64px alpha silhouette and
 * inlined as a data URI. Two reasons for that shape rather than <img src> to a
 * file in `public/`:
 *
 *  - The panel renders them through `mask-image` with `background: currentColor`,
 *    so a single asset reads correctly in both the light and dark themes. A
 *    colour PNG would need two copies and would still fight the theme.
 *  - The node UI is served by the daemon itself, sometimes from a filesystem the
 *    operator has trimmed. An inlined mark cannot 404.
 *
 * Regenerating: downscale the source to 64px, then convert luminance to alpha
 * (dark pixels become opaque ink). Keep them monochrome — anything with its own
 * colours will clash with the panel's status pills.
 */

export const AGENT_LOGO_DATA_URIS: Record<string, string> = {
  'openclaw':
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAEy0lEQVR42u2ba4hVVRTHf1OmM9GUjzITRmEyX4nglxwjzZKMIsFH' +
    'GEJJJlLfJGTGBD8kRkRCVmrRA8ueSqmRqJFOpqb2QafR0sovvbTygaPQpONM3s6W/43D7Z65Zx/OuWcfuAsWM/fOXnut/9pr7732' +
    '2nugQhWqUIWiUzVwC1CXgu466a5OC/wdwA9ADugE9gCPAD0S1NlDOvZIp9H9I9CQhgOmA98BrwIfAG0yaDswIgF9I9S30XFGOo3u' +
    'Vs8h96QVBVf6fh8IvCADTwFTfH8bANztOWk+sBLYAHyhkfwKaAbWAyvUZhJwk09+ivrMScdA39+qXFsX7gV+Bi4Ay4GtPuNt+LQX' +
    '2p8BL6ov0+fkLCyMozWiuZi5WX07S4OBNzVauYT4gnQMdg38w8DxBIEX8nHtBqlTL+ClMgIv5JdlQyp0LbAxRfB5/kS2lJWu0eqe' +
    'c4S3yqaykMnG1joEPs9rE85C/6MlDoLP89NJg5/sy8HDrNQ7gIMRwVwCWtTHiZAyF5NMi3sD31usztdLrqfODW0W4H8H7vPp7g+s' +
    'CSlrbLwuzdBvVn5u5uMqL2r2Ard6ETEvpPw/3iHrQekcBuwE3tEAHAjZx5IksrwzIZU/7jM+/90qjcq5EPLHgFr1sdj3/RhgYUgb' +
    'jK2D4nTA8xbh+5ivWPKGRu12L2HqE3Ia/OLpu1p9jAK+1kmxxsIBhp+LC3w/zcmwijcUyF+hn7O0sJWS79TRudhxd6flOtIvDgfM' +
    'tVy9zRxuBK7y9WEi4FeLPg4XnPxMND0bYSeZE4cDXrPY+vxsQv8tYDPwdwT5c0q1V3u7yKEI8p2qGFnTDcBQb+Wt18pbo89TlWgc' +
    'cTgROiIbp8rmamGo1+f+3QE3CcQWJR3m3N3uhf9vwDYtPg+oElujUXEN/GrZVidbm7yp97kwtAvTSZ0b/pcszVYWVUrJX5rfPR2L' +
    'hMOyqVE2hskYZ/uLmactlHWoYPmMQw5YKpsuWtYcLxdXn4igcGxEuaTY2HJbRDnrUlaHsqyljkXAIMsIyGlrvjx/bIRaIiQlSfOX' +
    'sqnFUu5blCzYJhc3ezvDeYcccF422WJ5FF0whk1U9snTaxzcBt+WbftCtjeYh+Rz7U0hBMxBZriurbocdECXbBse8tD1qf+cMa7E' +
    'AmISifuVSf3kcCZobLtRtraXyAPGFSZDTd10epdSyr0Og/dP096yOWiwGoPSYXNk3a3t4RttL30UVvszAD7P+2VzX2FoUZ1hF/BQ' +
    'mANRre/q+ymLapBL3Cbb89f4tVHvAFozCD7PrXHcFSzKsAMWxlEQGVpiRXWV25XjxELrM+iAj+OsCk9UrS8r4I2td8bpgCpVi7Li' +
    'gC1JPJ4aq6Ow6+A7VBtIhFZmwAErkrwdNhcNRx0GfzSuy5DuaJKjU6FDtpWFmhx0QFM53whV6cbIFfCvp/Fk1jxPW+cA+HVpPpUz' +
    'NzHvpgj+PdmQKpnT1rIUwC8r16swm+eyf5QB+J/S5STVKyy7Eip6vq/yt/M0HvgQOBsD8LNa6MaTQZoT8P7vSWAB8Iq200X6fKmb' +
    'N0eZpGkBo1rsn5waAtpOy7IDZgSAmlCk7YSAtjMqDsgwzQwANTGg6lSs7cwsO8DM64+K8MgibUcGtG2gQsnRv1P7PFimYrmBAAAA' +
    'AElFTkSuQmCC',
  'hermes':
    'data:image/png;base64,' +
    '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',
  'prime-agent':
    'data:image/png;base64,' +
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAEUElEQVR42u2Za4hWRRjHf7uuklZ0pSuRG26WUdHVIilqsduHXa39' +
    'UJBCJWWlkNLNCrthQR+iD4ZWFLFZEhWRKJYVka6Q+qnY7trFG9GuZRetzextBv4Lw2HOeed99z3nLNv8YfZlmTkzzzPnufyf50BE' +
    'RERERERERERERETEiMcRwAH/J4UPAqYAC4E1wE7gY+C4kaz0aOBSYDHwDVDxjPaRqPhhwGxgU4rSg+N5YOxIUnwMcCvwdRXF7XgM' +
    'aG7UwQcD5wHnAseUpPxkY+4fBSj+BzCrkQdfDnwJ7NfoAz4E5ijSFuHn9wK/Byj/I3BFo33tu4wDrSlek6Pyk4D3AhS3Y6ustKE4' +
    '26SVf6scvA+4rcHnNgG3y9pClN8BnJPHGzjVmN+fAQLYS5jeoDNbgTcS+9uLeCfl7F3K/7lgArA38C1sA44d4nnX6226+/bIFR5N' +
    'efMX5RmArg5wAXc8Wec59uK6Pfs9Z3L58cALnrkf8jJ7F695Dv7EpJq7UnJxfx3Us9PD4v4B7tP8ZZ5zdio+5YoLgQHP4VdpfmWK' +
    'FcwN3P9IYInHwqzLzXTWnZJIgft1abnjrZS3byusccDmlAtYF8DAbK7u9Tz7C9ChNW3mz8PiIO6aZ4pQ/nzgb4+AMzR/ckZw3Kv5' +
    'NF7xtLJG8rmfgalOJtjlzFlL3GAC7c1ASxEX4As6PeLiyA2yguEdnj3bZUGVlDc/NbH+YrlChy50VFGc+2gPARmQQIO4u8oF9Do0' +
    '+XBlh4GM9XMcAjTPMLpVRulXlRlelys0F3UB13kE7E6seSkgJX5qeMSyjFhhx1+KNWOcam9bCscYV9QFLPf49GnO/KiAOjx0LJN5' +
    'jzfnTjRF1iVKpe6aX03Ov7HIsnNDQoAVntL4+wYovxv4AvhANPdtFT5r9f/L4gKTiq67Z4qY7JGgt3gKlcnqt9Wj+JtKgyeojzda' +
    '+05JWFqpaNHtV1KaC03K97Uq/xlwiGe/+WJ//XkWNrXA0s8tEnq5Z/6COpS3fYUzE/vYDLHUQ7YOLFP5WY75D5aiyTbYWTUqv0qV' +
    'pWtB01PYYEX7l4K5KdXfnYl1zXIRG7Ce8tDVipjk+0bJrsRzV5o6490qqbGtDOWnZZCVrxSw0uDygs9NYFtkgt3pzrz1+xt0YdWs' +
    'ZXWRrG8QJ6rEzBJsXsbzC9Q5WqRiaazM+CZT6z/rxJNqY08RNb4P3QHC9Sv9pbXNJ6hGf8XEke01NlLSXK0QnCG/CxGwTxnCB+vb' +
    'vw2BGD1RVuB7vEZBfxJtdXGoIVDf1qm4zf8PlKW8jcrr6xD6wcQ+HXUqvzXn7wpBX116axB4QGVqa2Kf++ukxOOHA+tbHWimK9Un' +
    '9GFhDYpvSfT8SkdXhrC2LfViAD9vD1DcptlHgKMYZmjyBMI+fYhorSGWPKTWVrKXsNH83qP+/rBGpwqfxUOgoicB16p52amWdgsR' +
    'EREREREREREREREREaXhPxXZ1AH/I5YbAAAAAElFTkSuQmCC',
};

/** Undefined for agents that ship no mark — the panel simply renders no chip. */
export function agentLogoDataUri(integrationId: string): string | undefined {
  return AGENT_LOGO_DATA_URIS[integrationId.trim().toLowerCase()];
}
